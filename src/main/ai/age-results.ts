import type { ChatMessage } from '../../shared/api';
import { estimateTextTokens } from '../../shared/context-fit';
import { spillText } from './spill';

/**
 * Свёртка старых результатов инструментов — вместо выбрасывания целых ходов.
 *
 * Обрезка истории (`trimMessagesToFit`) умеет одно: выбросить ход целиком вместе
 * с вопросом и ответом. Для длинного прогона это дорого с обеих сторон: платим
 * за токены на каждом шаге, а потом теряем сразу всё, включая текст, который
 * агент ещё не использовал.
 *
 * Свёртку «по возрасту» в проекте уже пробовали и откатили: агент терял
 * прочитанное. Причина была в том, что текст исчезал без адреса. Здесь адрес
 * остаётся: содержимое уходит в файл (`ai/spill.ts`), а в истории вместо него
 * стоит строка с путём и номером строки — перечитать нужное можно одним
 * `read_file`, ничего не запуская заново.
 *
 * Свёртка трогает только роль `tool`: пары «вызов — ответ» остаются на месте,
 * провайдер не получает битую историю, а вопрос и ответы модели не меняются.
 */
export interface AgeOptions {
  /** Сколько последних сообщений не трогаем: свежий шаг нужен целиком. */
  keepRecent: number;
  /** Сколько токенов надо освободить. Ноль и меньше — свёртка не нужна. */
  needTokens: number;
  /** Каталог копий. Без него текст теряется — тогда лучше не свёртывать. */
  spillDir?: string;
  /** Короче этого не трогаем: строка-адрес стоит почти столько же. */
  minChars?: number;
}

export interface AgeOutcome {
  /** Сколько сообщений свёрнуто. */
  aged: number;
  /** Сколько токенов примерно освобождено. */
  freedTokens: number;
  /** Файл с полным текстом, если он появился. */
  file: string | null;
}

/**
 * Свёртка по возрасту: убрать из истории всё, что уже отработало.
 *
 * Обычная свёртка (`ageToolResults`) ждёт, пока окно не полезет вон. До этого
 * момента все результаты едут на КАЖДОМ шаге: в прогоне из шестнадцати шагов
 * один `read_file` на 4 000 токенов платится пятнадцать раз. Здесь порог другой —
 * возраст: результат старше `keepRecent` сообщений и длиннее `minChars` уже не
 * нужен целиком, у него есть адрес.
 *
 * Почему порог по возрасту, а не «сворачивай самое старое до нужного места»:
 * свёртка идёт по границе возраста и каждое сообщение пересекает её один раз.
 * Значит середина истории меняется только в той точке, где стоит граница, а всё
 * до неё стабильно — и префикс запроса, который кэширует провайдер, не слетает
 * задним числом. Свёрнутая пометка короче `minChars`, так что второй раз в
 * выборку она не попадёт: повторной свёртки одного сообщения нет.
 *
 * Пачка — не меньше `batchSize` сообщений: один файл на проход, а уборка держит
 * всего сорок копий, поэтому сворачивать по одному сообщению на шаг нельзя.
 */
export interface StaleOptions {
  /** Сколько последних сообщений не трогаем. */
  keepRecent: number;
  spillDir?: string;
  /** Короче этого не трогаем: пометка с адресом стоит почти столько же. */
  minChars?: number;
  /** Сколько кандидатов набрать, чтобы стоило делать проход (и файл). */
  batchSize?: number;
}

const MIN_AGE_CHARS = 1_500;
/** По умолчанию: результат короче четырёх тысяч символов не стоит адреса в истории. */
const STALE_MIN_CHARS = 4_000;
const STALE_BATCH = 2;

/** Свернуть выбранные сообщения в один файл и заменить их пометками с адресом. */
function foldPicked(messages: ChatMessage[], picked: readonly number[], spillDir: string): AgeOutcome {
  // Один файл на проход, а не по файлу на сообщение: уборка держит всего сорок
  // копий (`MAX_SPILL_FILES`), и десяток свёрнутых результатов вытеснил бы
  // настоящие хвосты команд.
  const blocks: string[] = [];
  const starts = new Map<number, number>();
  let line = 1;
  let freed = 0;
  for (const index of picked) {
    const message = messages[index]!;
    const content = typeof message.content === 'string' ? message.content : '';
    freed += estimateTextTokens(content) - 12;
    const heading = `### ${message.name ?? 'tool'} · ${index + 1}`;
    starts.set(index, line + 1);
    blocks.push(heading);
    blocks.push(content);
    blocks.push('');
    line += 3 + content.split('\n').length;
  }
  const file = spillText(spillDir, 'svernutye-rezultaty', blocks.join('\n'));

  for (const index of picked) {
    const message = messages[index]!;
    const size = typeof message.content === 'string' ? message.content.length : 0;
    const where = file ? `${file}:${starts.get(index) ?? 1}` : '';
    const stub = where
      ? `[свёрнуто: ${message.name ?? 'tool'}, ${size} симв. — текст в ${where}, читайте read_file с диапазоном]`
      : `[свёрнуто: ${message.name ?? 'tool'}, ${size} симв. — перечитайте инструментом, если нужно]`;
    // Заменяем объект, а не содержимое: ту же ссылку держит `produced` — то,
    // что человек видит в карточке и что ложится в файл беседы.
    messages[index] = { ...message, content: stub };
  }

  return { aged: picked.length, freedTokens: Math.max(0, freed), file };
}

/** Кандидаты на свёртку: результаты инструментов до `lastIndex`, длиннее `minChars`. */
function candidates(messages: ChatMessage[], lastIndex: number, minChars: number): number[] {
  const picked: number[] = [];
  for (let index = 0; index < lastIndex; index += 1) {
    const message = messages[index]!;
    if (message.role !== 'tool') continue;
    const content = message.content;
    if (typeof content !== 'string' || content.length < minChars) continue;
    picked.push(index);
  }
  return picked;
}

export function ageToolResults(messages: ChatMessage[], options: AgeOptions): AgeOutcome {
  // Без файла свёртка была бы потерей, а не экономией: агент увидел бы
  // «здесь был вывод» и не смог его достать.
  if (!options.spillDir || options.needTokens <= 0) return { aged: 0, freedTokens: 0, file: null };

  const last = Math.max(0, messages.length - Math.max(0, options.keepRecent));
  const all = candidates(messages, last, options.minChars ?? MIN_AGE_CHARS);
  // Берём только то, что нужно для места: свёртка ради свёртки меняет историю
  // без пользы и сбрасывает кэш префикса у провайдера.
  const picked: number[] = [];
  let freed = 0;
  for (const index of all) {
    if (freed >= options.needTokens) break;
    picked.push(index);
    freed += estimateTextTokens(messages[index]?.content ?? '') - 12;
  }
  if (picked.length === 0) return { aged: 0, freedTokens: 0, file: null };
  return foldPicked(messages, picked, options.spillDir);
}

/**
 * Свёртка по возрасту — каждый шаг, не дожидаясь переполнения окна.
 *
 * Обычная свёртка ждёт, пока история перестанет влезать. До этого момента все
 * результаты едут на КАЖДОМ шаге: `read_file` на 4 000 токенов в прогоне из
 * шестнадцати шагов платится пятнадцать раз. Здесь порог другой — возраст:
 * результат старше `keepRecent` сообщений и длиннее `minChars` больше не нужен
 * целиком, у него есть адрес.
 *
 * Каждое сообщение пересекает границу возраста ровно один раз, поэтому история
 * меняется только у границы, а всё до неё стабильно — кэш префикса у провайдера
 * не слетает задним числом. Пометка короче `minChars`, так что второй раз в
 * выборку она не попадёт.
 *
 * Пачка — не меньше `batchSize`: один проход пишет один файл, а уборка держит
 * сорок копий, поэтому сворачивать по одному сообщению на каждом шаге нельзя.
 */
export function ageStaleResults(messages: ChatMessage[], options: StaleOptions): AgeOutcome {
  if (!options.spillDir) return { aged: 0, freedTokens: 0, file: null };

  const last = Math.max(0, messages.length - Math.max(0, options.keepRecent));
  const picked = candidates(messages, last, options.minChars ?? STALE_MIN_CHARS);
  if (picked.length < (options.batchSize ?? STALE_BATCH)) return { aged: 0, freedTokens: 0, file: null };
  return foldPicked(messages, picked, options.spillDir);
}
