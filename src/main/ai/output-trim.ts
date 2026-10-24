/**
 * Сколько места шаг отдаёт модели и как режется всё, что не влезло.
 *
 * Бюджет (`outputRoom`/`spendRoom`) и обрезка (`clipText`/`clipTail`/
 * `truncateTail`) — одна тема, её правят вместе. Решение «что показать, а что
 * положить в spill-файл» стоит дорого (потолки — в `output-budget.ts`), поэтому
 * к нему ходят читать, а не листать тысячи строк инструментов рядом.
 */
import { collapsePassedTests, compressToolOutput, looksLikeTestRun } from '../../shared/output-compress';
import { MAX_OUTPUT_CHARS, MIN_OUTPUT_CHARS } from './output-budget';
import { spillHint, spillText } from './spill';
import type { ToolContext } from './tool-context';

/**
 * Свернуть перечисление прошедших тестов, положив полный вывод в файл-копию.
 *
 * Сотни строк `✓ имя теста 3ms` модели не сообщают ничего сверх итоговой строки,
 * но платятся целиком: свежий ответ инструмента не попадает в кеш промпта, в
 * отличие от префикса. Свёрнутое не теряется — адрес копии стоит в пометке.
 * Применяется только там, где рядом есть итог прогона (`looksLikeTestRun`):
 * в произвольном выводе команды строка с `✓` может быть данными.
 */
export function foldPassedTests(ctx: ToolContext, kind: string, text: string, fullFile?: string): string {
  if (!looksLikeTestRun(text)) return text;
  const folded = collapsePassedTests(text);
  if (folded.hidden === 0) return text;
  const file = fullFile ?? spill(ctx, kind, text);
  const where = file ? `; ${spillHint(file)}` : '';
  return `${folded.text}\n… (свёрнуто отметок о прошедших: ${folded.hidden}${where})`;
}

/**
 * Причесать вывод процесса. Правила живут в `shared/output-compress.ts` — там же,
 * где сжатие перед отправкой модели (`ai/service.ts`): одному выводу незачем
 * выглядеть по-разному в зависимости от того, кто его получил. Здесь важен ещё и
 * `truncateTail` ниже: у вывода команд хвост информативнее начала.
 */
export function condenseOutput(text: string): string {
  return compressToolOutput(text);
}

/**
 * Обрезка с конца: у вывода терминала и команд важнее последние строки — начало
 * (приветствие, старая сборка) модели уже не нужно. Оставляем хвост и говорим,
 * сколько символов отброшено, чтобы она знала, что видит не весь вывод.
 */
export function truncateTail(text: string, limit = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  const dropped = text.length - limit;
  return `… (отброшено символов в начале: ${dropped})\n${text.slice(dropped)}`;
}

/**
 * Хвостовая обрезка вывода команды с учётом бюджета шага. Копия вывода пишется
 * потоком (`spillStream`), поэтому второй файл не нужен — но бюджет шага общий,
 * и команда с мегабайтом лога не должна обходить его только потому, что копию ей
 * сделали заранее.
 */
export function trimCommandTail(ctx: ToolContext, text: string, full: string | null): string {
  const room = outputRoom(ctx);
  const tail = text.length <= room ? text : truncateTail(text, room);
  spendRoom(ctx, Math.min(text.length, room));
  return tail.length < text.length && ctx.stepBudget !== undefined && ctx.stepBudget.left <= 0
    ? `… (бюджет вывода на шаг исчерпан${full ? `, ${spillHint(full)}` : ''})\n${tail}`
    : tail;
}

/**
 * Обрезка с копией: отброшенное уходит в файл, модели — путь к нему.
 *
 * Пометка «вывод обрезан» без адреса была тупиком: агент знал, что чего-то не
 * видит, но не мог это достать и перезапускал команду — а второй запуск даёт
 * уже другой вывод. `read` с диапазоном умеет прочитать такой файл, поэтому
 * достаточно назвать путь.
 */
export function clipText(ctx: ToolContext, kind: string, text: string): { text: string; truncated: boolean } {
  const room = outputRoom(ctx);
  if (text.length <= room) {
    spendRoom(ctx, text.length);
    return { text, truncated: false };
  }
  const file = spill(ctx, kind, text);
  spendRoom(ctx, room);
  return {
    text: `${text.slice(0, room)}\n${clipNote(ctx, file, 'вывод обрезан')}`,
    truncated: true,
  };
}

/** То же для хвостовой обрезки: начало отброшено, но его можно прочитать. */
export function clipTail(ctx: ToolContext, kind: string, text: string, limit = MAX_OUTPUT_CHARS): string {
  const room = Math.min(limit, outputRoom(ctx, limit));
  if (text.length <= room) {
    spendRoom(ctx, text.length);
    return text;
  }
  const dropped = text.length - room;
  const file = spill(ctx, kind, text);
  spendRoom(ctx, room);
  const note = file ? `, ${spillHint(file)}` : '';
  const spent = ctx.stepBudget !== undefined && ctx.stepBudget.left <= 0 ? ' — бюджет вывода на шаг исчерпан' : '';
  return `… (отброшено символов в начале: ${dropped}${note}${spent})\n${text.slice(dropped)}`;
}

/**
 * Сколько символов этот вызов может отдать модели: свой предел, но не больше
 * остатка бюджета шага. Без бюджета (проверки, одиночный вызов) — просто предел.
 */
export function outputRoom(ctx: ToolContext, wanted = MAX_OUTPUT_CHARS): number {
  if (!ctx.stepBudget) return wanted;
  const left = Math.max(ctx.stepBudget.left, MIN_OUTPUT_CHARS);
  return Math.max(MIN_OUTPUT_CHARS, Math.min(wanted, left));
}

/** Списать отданное из бюджета шага. */
export function spendRoom(ctx: ToolContext, chars: number): void {
  if (!ctx.stepBudget) return;
  ctx.stepBudget.left = Math.max(0, ctx.stepBudget.left - chars);
}

/** Пометка «обрезано» с адресом копии и признаком исчерпанного бюджета шага. */
export function clipNote(ctx: ToolContext, file: string | null, what: string): string {
  const spent = ctx.stepBudget !== undefined && ctx.stepBudget.left <= 0 ? ' — бюджет вывода на шаг исчерпан' : '';
  return file ? `… (${what}${spent}; ${spillHint(file)})` : `… (${what}${spent})`;
}

/** Положить текст в файл, если каталог задан. Без каталога поведение прежнее. */
export function spill(ctx: ToolContext, kind: string, text: string): string | null {
  return ctx.spillDir ? spillText(ctx.spillDir, kind, text) : null;
}

/** Строка о полной копии вывода: дописывается к хвосту команды. */
export function spillNote(file: string | null): string {
  return file ? `\n(${spillHint(file)})` : '';
}

/**
 * Бинарный ли это файл. Признак один и тот же по всему проекту — нулевой байт
 * (так же его отличает `search` и кэш содержимого). Декодированный в utf8
 * бинарник превращается в мусор с U+FFFD, и по нему не видно причины.
 */
export function isBinary(text: string): boolean {
  return text.includes('\u0000');
}
