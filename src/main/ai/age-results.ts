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

const MIN_AGE_CHARS = 1_500;

export function ageToolResults(messages: ChatMessage[], options: AgeOptions): AgeOutcome {
  const nothing: AgeOutcome = { aged: 0, freedTokens: 0, file: null };
  // Без файла свёртка была бы потерей, а не экономией: агент увидел бы
  // «здесь был вывод» и не смог его достать.
  if (!options.spillDir || options.needTokens <= 0) return nothing;

  const minChars = options.minChars ?? MIN_AGE_CHARS;
  const last = Math.max(0, messages.length - Math.max(0, options.keepRecent));
  const picked: number[] = [];
  let freed = 0;
  for (let index = 0; index < last && freed < options.needTokens; index += 1) {
    const message = messages[index]!;
    if (message.role !== 'tool') continue;
    const content = message.content;
    if (typeof content !== 'string' || content.length < minChars) continue;
    picked.push(index);
    freed += estimateTextTokens(content) - 12;
  }
  if (picked.length === 0) return nothing;

  // Один файл на проход, а не по файлу на сообщение: уборка держит всего сорок
  // копий (`MAX_SPILL_FILES`), и десяток свёрнутых результатов вытеснил бы
  // настоящие хвосты команд.
  const blocks: string[] = [];
  const starts = new Map<number, number>();
  let line = 1;
  for (const index of picked) {
    const message = messages[index]!;
    const heading = `### ${message.name ?? 'tool'} · ${index + 1}`;
    starts.set(index, line + 1);
    blocks.push(heading);
    blocks.push(typeof message.content === 'string' ? message.content : '');
    blocks.push('');
    line += 3 + (typeof message.content === 'string' ? message.content.split('\n').length : 0);
  }
  const file = spillText(options.spillDir, 'svernutye-rezultaty', blocks.join('\n'));

  let aged = 0;
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
    aged += 1;
  }

  return {
    aged,
    freedTokens: Math.max(0, freed - picked.length * 12),
    file,
  };
}
