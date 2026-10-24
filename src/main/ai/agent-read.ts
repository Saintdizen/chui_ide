import { formatOutline } from '../../shared/lsp-symbols';
import { confirmFile, coveredRequest, readStamp, uncoveredRequest } from '../../shared/read-coverage';
import { MAX_OUTPUT_CHARS, MAX_OUTPUT_TOKENS, MIN_OUTPUT_CHARS } from './output-budget';
import { fitOutput, fitOutputLines } from '../../shared/output-budget';
import { isBinary, outputRoom, spendRoom, spill } from './output-trim';
import { spillHint } from './spill';
import { estimateTextTokens } from '../../shared/context-fit';
import { booleanArg, describeValue, integerArg, isAbsent } from '../../shared/tool-args';
import { requireString } from './tool-args';
import { MAX_READ_FILES, readDispatch } from './agent-lookup';
import { relative } from './agent-terminal';
import type { ToolContext, ToolOutcome } from './tool-context';

/** Сколько строк отдаёт read за один диапазонный вызов. */
const MAX_READ_LINES = 2000;
/**
 * Файл длиннее — читается не целиком, а головой и оглавлением. Отдать 60 000
 * символов начала — это ~15 000 токенов вслепую: конец файла всё равно не виден,
 * и модель просит следующие диапазоны наугад.
 *
 * Порог опущен с 250 до 160 по замеру восьми «целых» чтений в живых беседах:
 * за следующим диапазоном того же файла модель пошла лишь в одном случае из восьми —
 * значит, целиком она читает не ради полноты, а за компанию, и голова с оглавлением
 * отвечает на тот же вопрос дешевле.
 */
const WHOLE_FILE_MAX_LINES = 160;
/**
 * Сколько строк показываем из длинного файла и с какой просить продолжение.
 * Голова нужна, чтобы узнать файл (шапка, импорты, первые объявления); остальное
 * дешевле взять оглавлением и диапазоном. 200 строк — ~1 400 токенов за вызов,
 * 120 — вдвое меньше, а оглавление всё равно назовёт номера нужных строк.
 */
const LONG_FILE_HEAD_LINES = 120;

/**
 * Чтение: `read` одним файлом (с диапазоном) и пачкой, плюс покрытие — что уже
 * прочитано и не изменилось.
 *
 * Вынесено из `agent-tools.ts` целиком: у чтения свои потолки (строки, символы,
 * бюджет вывода) и своё понятие «файл прочитан»; сам `agent-tools.ts` остаётся
 * таблицей имён и аргументов и сюда больше не растёт. `readDispatch` в
 * `agent-lookup.ts` разбирает только форму аргументов — это знание осталось там.
 */
async function readOne(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (Array.isArray(args.paths)) return await readFiles(ctx, args);
  if (isAbsent(args.path)) {
    return {
      ok: false,
      summary: 'Не сказано, что читать',
      detail: 'Нужен `path` для одного файла (можно с startLine/endLine) или `paths` — список из 2–5 файлов.',
    };
  }
  return await readFile(ctx, args);
}

/**
 * Строки с номерами — в том виде, в каком их видит модель: номер, черта, текст.
 * Один и тот же вид у диапазонного чтения и у головы длинного файла: номера
 * должны годиться в правку по позициям без пересчёта.
 */
/** Сколько места съедает номер строки (−) с пробелами; по нему считаем бюджет ниже. */
function numberWidth(from: number, count: number): number {
  const last = String(from + Math.max(0, count - 1)).length;
  return last + 3;
}

function numberedLines(lines: readonly string[], from: number): string {
  // Без выравнивания: модель читает числа, а не колонку.
  return lines.map((line, index) => `${from + index} | ${line}`).join('\n');
}

/** Полные строки и точное продолжение: обрезанный префикс тоже попадает в покрытие. */
function readPrefix(
  ctx: ToolContext,
  lines: readonly string[],
  from: number,
  chars = outputRoom(ctx),
  tokens = MAX_OUTPUT_TOKENS,
) {
  const full = lines.join('\n');
  tokens = Math.min(
    tokens,
    Math.max(Math.ceil(MIN_OUTPUT_CHARS / 3.5), ctx.stepBudget?.tokensLeft ?? MAX_OUTPUT_TOKENS),
  );
  // Запас на заголовок, продолжение и ссылку на полную копию.
  const limit = {
    chars: Math.max(0, chars - Math.min(700, Math.floor(chars / 3))),
    tokens: Math.max(0, tokens - Math.min(500, Math.floor(tokens / 3))),
  };
  // Режем чистый текст, а не пронумерованный: `12345 | ` — сервисная обвязка,
  // и если считать её в бюджете, длинный файл обрезается раньше, чем кончится
  // сам текст (перепись: 5 % чтений уходило на номера).
  const fitted = fitOutputLines(full, limit);
  let kept = fitted.lines;
  if (!fitted.complete) {
    // Строки вместе с номерами стоят дороже: ужимаем до тех пор, пока
    // пронумерованный префикс не влезет в те же два потолка.
    while (kept > 0) {
      const text = numberedLines(lines.slice(0, kept), from);
      if (text.length <= limit.chars && estimateTextTokens(text) <= limit.tokens) break;
      // Ширина номера — 3 символа и ещё до 2 на сам текст: шаг не меньше 1.
      kept -= Math.max(1, Math.ceil((text.length - limit.chars) / (numberWidth(from, kept) + 2)));
    }
  }
  const text = numberedLines(lines.slice(0, Math.max(0, kept)), from);
  if (
    !fitted.complete &&
    ctx.stepBudget &&
    (ctx.stepBudget.left < MAX_OUTPUT_CHARS || (ctx.stepBudget.tokensLeft ?? Infinity) < MAX_OUTPUT_TOKENS)
  )
    ctx.stepBudget.exhausted = true;
  const last = from + kept - 1;
  const file = fitted.complete ? null : spill(ctx, 'read', full);
  const note = fitted.complete
    ? ''
    : `\n… (вывод обрезан; ${kept > 0 ? `показаны строки ${from}–${last}` : `строка ${from} показана частично`}; дальше read с диапазоном: startLine с ${last + 1}${file ? `; ${spillHint(file)}` : ''})`;
  // Если даже первая строка не помещается, показываем фрагмент, но не помним её прочитанной.
  const fragment = kept === 0 ? fitOutput(lines.length ? numberedLines(lines.slice(0, 1), from) : '', limit) : '';
  return { text: (text || fragment) + note, last, complete: fitted.complete };
}

/**
 * Оглавление длинного файла от языкового сервера: объявления с номерами строк.
 * Нет сервера или он не разобрал — пустая строка: голова файла всё равно полезна,
 * а выдумывать оглавление нельзя.
 */
async function fileOutlineText(ctx: ToolContext, target: string, text: string): Promise<string> {
  const symbols = ctx.symbols;
  if (!symbols?.outline) return '';
  const language = symbols.languageFor?.(target);
  if (!language) return '';
  try {
    const outline = await symbols.outline(target, language, text);
    if (!outline || outline.length === 0) return '';
    return formatOutline(relative(target, ctx.workspace.rootPath()), outline, {
      totalLines: text.length === 0 ? 0 : text.split('\n').length,
    }).detail;
  } catch {
    // Сервер не ответил — это не повод отказывать в чтении.
    return '';
  }
}

export async function readAction(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const dispatch = readDispatch(args);
  if (dispatch === 'files') return await readFiles(ctx, args);
  if (dispatch === 'one') return await readOne(ctx, args);
  return {
    ok: false,
    summary: 'Не сказано, что читать',
    detail: 'Нужен `path` для одного файла (можно с startLine/endLine) или `paths` — список из 2–5 файлов.',
  };
}

export async function readFile(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const { workspace } = ctx;
  const target = requireString(args, 'path');
  const rel = relative(target, workspace.rootPath());
  // Запрос «весь файл» = без startLine и без внятного endLine (нет его или это не число).
  const wholeFile = isAbsent(args.startLine) && integerArg(args.endLine) === undefined;
  // Запрос «весь файл», уже целиком показанный выше в ветке и с тех пор не менявшийся:
  // отдаём весточку, а не текст второй раз (65 % чтений — первое чтение, и ещё часть —
  // его буквальный повтор). Версию `coveredWhole` сверяет по `stat` перед ответом,
  // поэтому файл, поправленный мимо инструментов (терминал, git, внешний редактор),
  // повтором не подавляется. `force: true` — явное «перечитай», текст мог выпасть.
  if (ctx.coveredReads && booleanArg(args.force) !== true && wholeFile) {
    const whole = await coveredWhole(ctx, target);
    if (whole !== undefined) {
      return {
        ok: true,
        summary: `${rel}: уже прочитано`,
        detail:
          `${rel}: строки 1–${whole} уже есть выше в ветке, файл с той поры не менялся — не повторяю. ` +
          'Если текст выпал из контекста, зови read с force: true.',
      };
    }
  }
  const content = await workspace.readFile(target);
  // Бинарный файл в utf8 — это мусор, который зря жжёт контекст и ничего не
  // объясняет. Отказываем словами (тот же нулевой байт, по которому поиск
  // отличает бинарное от текстового).
  if (isBinary(content.text)) {
    return {
      ok: false,
      summary: `${rel}: бинарный файл`,
      detail: 'Это не текстовый файл — читать его бессмысленно. Если нужны метаданные, используй list.',
    };
  }
  // Версия файла на момент чтения: по ней потом видно, устарел ли текст в ветке.
  const stamp = readStamp(content);
  const allLines = content.text.length === 0 ? [] : content.text.split('\n');
  const total = allLines.length;

  // Границы диапазона. Число строки приходит и строкой («2» — модели шлют и так),
  // и тогда его надо принять. А вот если значение ПРИШЛО и не разбирается (2.5, «abc»),
  // молчать нельзя: отбрасывание аргумента читало бы весь файл вместо запрошенного
  // куска — лишний расход контекста и ответ не про то, что просили.
  const startLine = integerArg(args.startLine);
  const endLine = integerArg(args.endLine);
  if (startLine === undefined && !isAbsent(args.startLine)) {
    throw new Error(`startLine: нужен целый номер строки, получено ${describeValue(args.startLine)}`);
  }
  if (endLine === undefined && !isAbsent(args.endLine)) {
    throw new Error(`endLine: нужен целый номер строки, получено ${describeValue(args.endLine)}`);
  }

  // Без диапазона: небольшой файл — целиком, длинный — головой и оглавлением.
  // Отдать 60 000 символов начала длинного файла — это ~15 000 токенов вслепую:
  // конец всё равно не виден, а модель просит диапазоны наугад.
  if (startLine === undefined && endLine === undefined) {
    if (total > WHOLE_FILE_MAX_LINES) {
      const prefix = readPrefix(ctx, allLines.slice(0, LONG_FILE_HEAD_LINES), 1);
      const outline = await fileOutlineText(ctx, target, content.text);
      const tail =
        `… (файл длинный: строк всего ${total}, показаны первые ${prefix.last}). ` +
        `Дальше — read с startLine с ${prefix.last + 1}` +
        `${outline ? ' или нужный раздел из оглавления выше' : ' или lsp (action: outline)'}.`;
      const body = `${prefix.text}\n\n${tail}${outline ? `\n\nОглавление:\n${outline}` : ''}`;
      // Оглавление не должно отнять место у показанных строк и адреса продолжения.
      const limit = { chars: outputRoom(ctx), tokens: MAX_OUTPUT_TOKENS };
      let detail = fitOutput(body, limit);
      if (detail !== body) {
        const file = spill(ctx, 'read', body);
        const note = `\n… (оглавление обрезано${file ? `; ${spillHint(file)}` : ''})`;
        detail =
          fitOutput(body, { chars: limit.chars - note.length, tokens: limit.tokens - estimateTextTokens(note) }) + note;
      }
      spendRoom(ctx, detail.length);
      return {
        ok: true,
        summary: `${rel}: ${total} строк, показаны первые ${prefix.last}`,
        detail,
        ...(prefix.last > 0 && detail.startsWith(prefix.text)
          ? { read: { path: target, from: 1, to: prefix.last, stamp } }
          : {}),
      };
    }
    if (content.text.length <= outputRoom(ctx) && estimateTextTokens(content.text) <= MAX_OUTPUT_TOKENS) {
      spendRoom(ctx, content.text.length);
      return {
        ok: true,
        summary: `${rel}: ${total} строк`,
        detail: content.text || '(пустой файл)',
        ...(total > 0 ? { read: { path: target, from: 1, to: total, stamp, eof: true } } : {}),
      };
    }
    const prefix = readPrefix(ctx, allLines, 1);
    spendRoom(ctx, prefix.text.length);
    return {
      ok: true,
      summary: `${rel}: ${total} строк (обрезано)`,
      detail: prefix.text,
      ...(prefix.last > 0 ? { read: { path: target, from: 1, to: prefix.last, stamp, eof: prefix.complete } } : {}),
    };
  }

  if (total === 0) {
    return {
      ok: true,
      summary: `${rel}: пустой файл`,
      detail: '(пустой файл)',
    };
  }

  const from = Math.max(1, startLine ?? 1);
  // Конец за концом файла зажимаем: «3–99999» — это «от третьей строки до конца»,
  // и отказывать тут незачем. А вот начало за концом — другое дело: значит, о файле
  // думают неверно (он короче), и молча отдать пустоту было бы вредно.
  const to = Math.min(total, endLine ?? total);
  if (from > total) {
    return {
      ok: false,
      summary: `${rel}: начало диапазона ${from} за концом файла (в файле строк: ${total})`,
      detail:
        `Строки ${from} нет: файл короче, чем ожидалось (в нём ${total}). ` +
        `Перечитай файл целиком (read без диапазона) или посмотри скелет (lsp, action: outline) ` +
        `и возьми существующий диапазон в пределах 1–${total}.`,
    };
  }
  if (to < from) {
    return {
      ok: false,
      summary: `${rel}: конец диапазона ${to} раньше начала ${from}`,
      detail: 'Поменяй границы местами: startLine — первая строка диапазона, endLine — последняя.',
    };
  }

  // Диапазон тоже ограничиваем: модель может попросить «весь файл» через 1–∞.
  const last = Math.min(to, from + MAX_READ_LINES - 1);
  const prefix = readPrefix(ctx, allLines.slice(from - 1, last), from);
  const clipped =
    prefix.complete && last < to ? `\n… (показаны строки ${from}–${last} из ${to}; продолжай с ${last + 1})` : '';
  const detail = prefix.text + clipped;
  spendRoom(ctx, detail.length);
  return {
    ok: true,
    summary: `${rel}: строки ${from}–${prefix.last} из ${total}`,
    detail,
    ...(prefix.last >= from ? { read: { path: target, from, to: prefix.last, stamp, eof: prefix.last >= total } } : {}),
  };
}

/** Сколько файлов и сколько символов отдаёт `read` за один вызов. */
/**
 * Команда, которая только читает: `cat`, `head -n N`, `sed -n 'A,Bp'`, `grep`.
 *
 * В переписи (TASKS.md, п.43) 43% вызовов `terminal` — именно чтение через шелл.
 * Такой вызов дороже структурного со всех сторон: нет номеров строк, нет потолка
 * вывода, перед каждой второй командой стоит `cd <папка> &&`, и перед запуском
 * нужно подтверждение. Разбор нарочно узкий — одна простая команда без труб,
 * перенаправлений, глобов и подстановок; всё остальное идёт в шелл как раньше.
 */
export type LookupCall = {
  tool: 'read' | 'search' | 'list';
  args: Record<string, unknown>;
  label: string;
  /**
   * `grep -c`: вместо совпадений нужен только их счёт — его и печатаем.
   * Разбор при этом остаётся одним и тем же `search`.
   */
  countOnly?: boolean;
};

/**
 * Общий потолок пачки. Пачка и существует ради двух-трёх мелких файлов; 20 000
 * символов — это уже ~5 000 токенов, треть бюджета шага на один вызов. Пара
 * больших файлов при 30 000 съедала половину шага и отбивала у модели охоту
 * читать дальше: дешевле прочитать один, чем всю пачку сразу.
 */
const MAX_READ_FILES_TOTAL_CHARS = MAX_OUTPUT_CHARS;
/**
 * Потолок на один файл в пачке: 6 000 символов — это файл строк на 150. Пачка
 * существует ради двух-трёх мелких файлов, а длинный обрезается по границе
 * строки с пометкой «дальше read с диапазоном». Вопрос обычно решает середина
 * первого файла: остальное дешевле взять `read` с диапазоном по номеру строки.
 */
const READ_FILES_PER_FILE_CHARS = 6_000;

/**
 * Пакетное чтение: 2–5 файлов за один шаг. Каждый файл получает те же номера
 * строк, что и `read`, но общий вывод ограничен — иначе пятёрка больших
 * файлов вытеснит из контекста всё остальное.
 */
export async function readFiles(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const { workspace } = ctx;
  const raw = args.paths;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('Не задан аргумент «paths»: нужен непустой массив путей');
  }
  const paths = raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  if (paths.length === 0) throw new Error('В «paths» нет ни одного корректного пути');
  if (paths.length > MAX_READ_FILES) {
    throw new Error(`Слишком много файлов за один вызов: ${paths.length} (максимум ${MAX_READ_FILES})`);
  }

  const root = workspace.rootPath();
  const parts: string[] = [];
  const failed: string[] = [];
  /** Что из пачки окажется в покрытии: без этого повтор такой же пачки видел текст заново. */
  const reads: Array<{
    path: string;
    from: number;
    to: number;
    stamp?: string;
    eof?: boolean;
  }> = [];
  let total = 0;
  let read = 0;

  for (const target of paths) {
    const rel = relative(target, root);
    if (total >= MAX_READ_FILES_TOTAL_CHARS) {
      parts.push(`### ${rel}\n… (пропущен: общий лимит вывода исчерпан)`);
      continue;
    }
    // Файл уже прочитан целиком и не менялся с тех пор — текст есть выше, а его
    // повтор в пачке самый дорогой: замер показал 12 тыс. токенов на 3 таких вызова.
    const already = ctx.coveredReads && booleanArg(args.force) !== true ? await coveredWhole(ctx, target) : undefined;
    if (already !== undefined) {
      parts.push(`### ${rel} (уже прочитано: строки 1–${already}, без изменений)`);
      continue;
    }
    try {
      const content = await workspace.readFile(target);
      if (isBinary(content.text)) {
        failed.push(`${rel}: бинарный файл`);
        continue;
      }
      const lines = content.text.length === 0 ? [] : content.text.split('\n');
      let from = 1;
      if (ctx.coveredReads && booleanArg(args.force) !== true) {
        confirmFile(ctx.coveredReads, target, readStamp(content));
        from = uncoveredRequest('read', JSON.stringify({ path: target }), ctx.coveredReads)?.from ?? 1;
      }
      const room = Math.min(READ_FILES_PER_FILE_CHARS, outputRoom(ctx), MAX_READ_FILES_TOTAL_CHARS - total - 500);
      const tokens = MAX_OUTPUT_TOKENS - estimateTextTokens(parts.join('\n\n'));
      if (room < 800 || tokens < 600) {
        parts.push(`### ${rel}\n… (пропущен: общий лимит вывода исчерпан)`);
        continue;
      }
      const prefix = lines.length
        ? readPrefix(ctx, lines.slice(from - 1), from, room, tokens)
        : { text: '(пустой файл)', last: 0, complete: true };
      const shown =
        from > 1
          ? `, строки ${from}–${prefix.last}; начало уже прочитано`
          : prefix.complete
            ? ''
            : `, первые ${prefix.last}`;
      const chunk = `### ${rel} (${lines.length} строк${shown})\n${prefix.text}`;
      parts.push(chunk);
      total += chunk.length + 2;
      spendRoom(ctx, chunk.length + 2);
      read += 1;
      if (prefix.last >= from)
        reads.push({
          path: target,
          from,
          to: prefix.last,
          stamp: readStamp(content),
          eof: prefix.complete,
        });
    } catch (error) {
      failed.push(`${rel}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const failure of failed) parts.push(`### ошибка\n${failure}`);

  const summaryParts = [`прочитано файлов: ${read}`];
  if (failed.length > 0) summaryParts.push(`ошибок: ${failed.length}`);
  if (total >= MAX_READ_FILES_TOTAL_CHARS) summaryParts.push('вывод обрезан');

  return {
    ok: failed.length < paths.length,
    summary: summaryParts.join(', '),
    detail: parts.join('\n\n'),
    ...(reads.length > 0 ? { reads } : {}),
  };
}

/**
 * Полностью ли уже прочитан и не изменился ли файл: `eof`-кусок с начала и версия,
 * совпавшая со всеми кусками файла. Возвращает длину, если повтор не нужен.
 */
export async function coveredWhole(ctx: ToolContext, target: string): Promise<number | undefined> {
  const ranges = ctx.coveredReads?.get(target);
  if (!ranges || ranges.length === 0) return undefined;
  if (!ranges.some((range) => range.eof === true)) return undefined;
  const version = await ctx.workspace.stat(target).catch(() => null);
  if (!version || !confirmFile(ctx.coveredReads!, target, readStamp(version))) return undefined;
  return coveredRequest('read', JSON.stringify({ path: target }), ctx.coveredReads!)?.to;
}
