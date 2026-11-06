import type { FileEdit } from '../../shared/edits';
import type { ReadRange } from '../../shared/read-coverage';
import type { ChatSession } from '../ui/chat-session';
import type { Checkpoint } from '../ui/chat-checkpoints';

/**
 * Модель видит то же, что и ты.
 *
 * Весь остальной чат старанно показывает, что ушло в контекст: карточки вызовов,
 * чипы вложений, цена до отправки. Но никто не говорит самого неприятного: текст
 * файла модель могла прочитать ДО того, как ты его правил, и дальше она говорит
 * о коде, которого уже нет.
 *
 * Сверка «двух взглядов» на один файл уже есть в двух местах, и оба держат свою
 * половину: чекпойнт хода (`chat-checkpoints`) знает, каким файл был ДО, а память
 * чтений агента (`shared/read-coverage`) — какие строки он читал. Здесь они
 * складываются, но только для файлов, где расхождение видно человеку.
 */

/** Ход, с которого модель держит свою версию файла. */
export interface ModelView {
  /** Заголовок хода — тот же, что в меню отката. */
  turn: string;
  /** Номер хода (зеро-базовый), к которому вернёт откат. */
  index: number;
}

/**
 * Какую версию файла держит модель: ничего, текст, прочитанный ею, или готовую
 * правку, которую она сама и предложила.
 *
 * Отдельный вид у правки не для красоты: «правка ждёт согласия» и «модель
 * ошиблась в файле» требуют разных действий, и в одной строке они путаются.
 */
export type FileView = { kind: 'none' } | { kind: 'read'; text: string } | { kind: 'edit'; text: string };

export interface Drift {
  path: string;
  /** Сколько строк человек изменил с той версии, которую видит модель. */
  changed: number;
  /** Ход, с которого модель держит свою версию; `null` — версия неизвестна. */
  view: ModelView | null;
  /** Версия — собственная правка модели, которая ещё ждёт решения. */
  edit?: boolean;
}

/** Файлы, где версия модели и версия человека разошлись. */
function compareViews(current: ReadonlyMap<string, string>, view: ReadonlyMap<string, FileView>): Drift[] {
  const drifts: Drift[] = [];
  for (const [path, now] of current) {
    const seen = view.get(path);
    // Ничего не читали и не правили — сверять нечего, и строку в списке заводить не из чего.
    if (!seen || seen.kind === 'none') continue;
    const changed = countChanged(seen.text, now);
    if (changed === 0) continue;
    drifts.push({ path, changed, view: null, edit: seen.kind === 'edit' });
  }
  // Самые разошедшиеся — сверху: чинить их нужнее, а список всё равно режут.
  return drifts.sort((a, b) => b.changed - a.changed || a.path.localeCompare(b.path));
}

/** Подписать каждое расхождение ходом, в котором модель получила свою версию. */
function attachTurns(drifts: Drift[], checkpoints: readonly Checkpoint[]): Drift[] {
  return drifts.map((drift) => {
    // Самый ПОЗДНИЙ ход, в снимке которого файл уже есть, — та версия, что старше
    // всех остальных: снимок самого позднего хода сделан перед его первой правкой.
    let view: ModelView | null = null;
    for (let index = checkpoints.length - 1; index >= 0; index -= 1) {
      const checkpoint = checkpoints[index]!;
      if (!checkpoint.files.has(drift.path)) continue;
      view = { turn: checkpoint.title, index: checkpoint.messageIndex };
      break;
    }
    return { ...drift, view };
  });
}

/**
 * Сколько строк человек изменил с той версии, которую видит модель.
 *
 * Не полноценный диф: считаем только «убрано» и «добавлено» по общим строкам
 * в префиксе и суффиксе. Модели важно не точное число, а порядок величины.
 */
export function countChanged(before: string, after: string): number {
  if (before === after) return 0;
  const from = before.split('\n');
  const to = after.split('\n');
  let head = 0;
  while (head < from.length && head < to.length && from[head] === to[head]) head += 1;
  let tail = 0;
  while (
    tail < from.length - head &&
    tail < to.length - head &&
    from[from.length - 1 - tail] === to[to.length - 1 - tail]
  ) {
    tail += 1;
  }
  // Минимум единица: одну строку переписали целиком, и счётчик 0 сбивал бы с толку.
  return Math.max(1, from.length - head - tail + (to.length - head - tail));
}

/** Файлы, по которым модель и человек держат разные версии. */
export function driftOf(
  session: ChatSession,
  current: ReadonlyMap<string, string>,
  view: ReadonlyMap<string, FileView>,
): Drift[] {
  // Без чекпойнтов сверка не бессмысленна: ход, в котором модель получила свою
  // версию, просто остаётся неизвестным (`view: null`) — сама правда о том, что
  // версии разошлись, от этого не пропадает.
  const drifts = compareViews(current, view);
  return session.checkpoints?.length ? attachTurns(drifts, session.checkpoints) : drifts;
}

/**
 * Что модель помнит о файле, по памяти чтений. Файл, прочитанный кусками, отдаём
 * только если куски покрывают его с первой строки до конца: иначе сверка ругалась
 * бы на каждом наполовину прочитанном файле.
 * `texts` — текст файла как его знает приложение: без него диапазоны строк не в
 * чем сверить, а «версия модели» так и осталась бы неизвестной.
 */
export function readViews(
  reads: ReadonlyMap<string, readonly ReadRange[]>,
  texts: ReadonlyMap<string, string>,
): Map<string, FileView> {
  const views = new Map<string, FileView>();
  for (const [path, ranges] of reads) {
    const text = texts.get(path);
    if (!text) continue;
    const total = text.split('\n').length;
    const whole = ranges.some((range) => range.from <= 1 && (range.eof === true || range.to >= total));
    if (whole) views.set(path, { kind: 'read', text });
  }
  return views;
}

/** Версии модели по правкам, которые ещё ждут согласия: их модель точно видела. */
export function editViews(pending: readonly FileEdit[], texts: ReadonlyMap<string, string>): Map<string, FileView> {
  const views = new Map<string, FileView>();
  for (const file of pending) {
    const text = texts.get(file.path);
    if (text === undefined) continue;
    // Версия модели — не «что на диске», а «что она предлагает»: правка, ещё не
    // применённая, для сверки и есть её картина файла.
    views.set(file.path, { kind: 'edit', text: file.edits.map((edit) => edit.newText).join('\n') });
  }
  return views;
}

/** Строка для карточки правки: что именно разошлось и насколько. */
export function describeDrift(drift: Drift): string {
  const lines = `${drift.changed} ${drift.changed === 1 ? 'строка' : 'строк'}`;
  if (drift.edit) return `правка ждёт согласия · разошлось с файлом на ${lines}`;
  if (drift.view) return `модель видела его «${drift.view.turn}» · разошлось на ${lines}`;
  return `модель видела его раньше · разошлось на ${lines}`;
}

/**
 * Все файлы, где модель и человек могли разойтись: и прочитанные ею, и те, что
 * она уже предложила править. Ожидающая правка важнее чтения — модель там смотрела
 * на файл позже, и её версия моложе.
 */
export function modelViews(
  reads: ReadonlyMap<string, readonly ReadRange[]>,
  pending: readonly FileEdit[],
  texts: ReadonlyMap<string, string>,
): Map<string, FileView> {
  return new Map([...readViews(reads, texts), ...editViews(pending, texts)]);
}
