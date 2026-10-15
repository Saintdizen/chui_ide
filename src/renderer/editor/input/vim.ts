/**
 * Vim-режим: разбор клавиш и подсчёт участков. Чистая логика, без DOM.
 *
 * Редактор ведёт себя модально: в режиме «вставка» клавиши идут обычным путём (печатают
 * текст), а в «нормальном», «визуальном» и «визуально-строчном» — это команды Vim. Здесь
 * живёт перевод нажатия в команду: `vimKey` смотрит на текущее состояние (режим, набранный
 * счётчик, начатый оператор) и решает, что делать — выполнить, подождать ещё клавишу или
 * пропустить нажатие дальше (в режиме вставки).
 *
 * Модуль намеренно чистый: ни контроллера, ни вида. Движения и участки считаются по
 * тексту (`TextBuffer`), и это проверяется в Node. Применяет команды отдельный слой —
 * `vim-binding.ts`.
 *
 * Рядом с редактором стоит оговорка о модели каретки: у нас каретка стоит МЕЖДУ знаками,
 * а у Vim — НА знаке. Поэтому курсорные движения возвращают смещения «перед знаком», а
 * операторы учитывают это сами (движение к концу слова включительно и т.п.).
 */

import { graphemeAt, nextGraphemeBoundary, previousGraphemeBoundary, wordSegments } from '../core/graphemes';
import type { TextBuffer } from '../core/text-buffer';
import type { KeyChord } from './keymap';
import { moveVertical } from './motions';

/** Режим Vim. `insert` — обычный ввод (как без Vim-режима). */
export type VimMode = 'normal' | 'insert' | 'visual' | 'visual-line';

/** Оператор Vim: что делает команда с участком. */
export type VimOperator = 'delete' | 'change' | 'yank';

/** Движение курсора (в том числе как цель оператора). */
export type VimMotion =
  | 'charLeft'
  | 'charRight'
  | 'lineDown'
  | 'lineUp'
  | 'wordForward'
  | 'wordBackward'
  | 'wordEnd'
  | 'bigWordForward'
  | 'bigWordBackward'
  | 'bigWordEnd'
  | 'lineStart'
  | 'lineFirstNonBlank'
  | 'lineEnd'
  | 'docStart'
  | 'docEnd'
  | 'innerWord'
  | 'aWord';

/** Куда встать перед входом в режим вставки. */
export type InsertPlace = 'before' | 'after' | 'lineStart' | 'lineEnd' | 'newLineBelow' | 'newLineAbove';

/** Разобранная команда: слой-исполнитель её применяет. */
export type VimCommand =
  | { readonly kind: 'motion'; readonly motion: VimMotion; readonly count: number }
  | { readonly kind: 'operator'; readonly operator: VimOperator; readonly motion: VimMotion; readonly count: number }
  | { readonly kind: 'operatorLines'; readonly operator: VimOperator; readonly count: number }
  | { readonly kind: 'operatorSelection'; readonly operator: VimOperator }
  | { readonly kind: 'deleteChar'; readonly count: number }
  | { readonly kind: 'deleteCharBefore'; readonly count: number }
  | { readonly kind: 'deleteToEnd'; readonly change: boolean }
  | { readonly kind: 'put'; readonly after: boolean; readonly count: number }
  | { readonly kind: 'undo' }
  | { readonly kind: 'redo' }
  | { readonly kind: 'join'; readonly count: number }
  | { readonly kind: 'enterInsert'; readonly at: InsertPlace }
  | { readonly kind: 'replaceChar'; readonly char: string; readonly count: number }
  | { readonly kind: 'toggleCase'; readonly count: number }
  | { readonly kind: 'swapEnds' }
  /** `.` — повторить последнюю правку. Что именно повторять, помнит слой-исполнитель. */
  | { readonly kind: 'repeat' }
  /** `/` и `?` — открыть поиск; `forward` — искать вперёд (`/`) или назад (`?`). */
  | { readonly kind: 'search'; readonly forward: boolean }
  /** `n` и `N` — следующий (`same`) или обратный поиску шаг. */
  | { readonly kind: 'searchRepeat'; readonly same: boolean }
  | { readonly kind: 'mode'; readonly mode: VimMode };

/** Состояние разбора между нажатиями: режим, счётчики, начатый оператор. */
export interface VimState {
  readonly mode: VimMode;
  /** Набранный счётчик (например, 12 в `12j`). 0 — не набран. */
  readonly count: number;
  /** Счётчик перед оператором (`2` в `2dw`): движение домножается на него. */
  readonly operatorCount: number;
  readonly operator: VimOperator | null;
  /** Нажато `g` — ждём вторую половину (`gg`). */
  readonly gPending: boolean;
  /** Ждём символ: `r` заменяет знак под кареткой на следующий набранный. */
  readonly awaitChar: null | 'replace';
  /** После `i`/`a` в операторе ждём объект текста (`iw`/`aw`). */
  readonly awaitTextObject: null | 'inner' | 'around';
}

/** Начальное состояние для режима. */
export function vimInitialState(mode: VimMode = 'normal'): VimState {
  return { mode, count: 0, operatorCount: 0, operator: null, gPending: false, awaitChar: null, awaitTextObject: null };
}

/** Сброс незавершённых нажатий; режим при этом сохраняется (кроме явного). */
function reset(state: VimState, mode: VimMode = state.mode): VimState {
  return { mode, count: 0, operatorCount: 0, operator: null, gPending: false, awaitChar: null, awaitTextObject: null };
}

/** Что вышло из нажатия. */
export type VimStep =
  /** Нажатие не наше — пропустить дальше (ввод текста в режиме вставки). */
  | { readonly kind: 'pass' }
  /** Приняли, но ждём ещё клавишу (набран счётчик, начат оператор). */
  | { readonly kind: 'wait'; readonly state: VimState }
  /** Готовая команда: выполнить и взять новое состояние. */
  | { readonly kind: 'run'; readonly command: VimCommand; readonly state: VimState };

function run(command: VimCommand, state: VimState): VimStep {
  return { kind: 'run', command, state };
}

function wait(state: VimState): VimStep {
  return { kind: 'wait', state };
}

/** Движение для клавиши в нормальном и визуальном режимах. `null` — это не движение. */
function motionForKey(key: string): VimMotion | null {
  switch (key) {
    case 'h':
      return 'charLeft';
    case 'l':
      return 'charRight';
    case 'j':
      return 'lineDown';
    case 'k':
      return 'lineUp';
    case 'w':
      return 'wordForward';
    case 'b':
      return 'wordBackward';
    case 'e':
      return 'wordEnd';
    case 'W':
      return 'bigWordForward';
    case 'B':
      return 'bigWordBackward';
    case 'E':
      return 'bigWordEnd';
    case '0':
      return 'lineStart';
    case '^':
      return 'lineFirstNonBlank';
    case '$':
      return 'lineEnd';
    case 'G':
      return 'docEnd';
    default:
      return null;
  }
}

/** Стрелки, Home, End и прочие именованные клавиши как движение. */
function namedMotion(key: string): VimMotion | null {
  switch (key) {
    case 'ArrowLeft':
      return 'charLeft';
    case 'ArrowRight':
      return 'charRight';
    case 'ArrowUp':
      return 'lineUp';
    case 'ArrowDown':
      return 'lineDown';
    case 'Home':
      return 'lineStart';
    case 'End':
      return 'lineEnd';
    default:
      return null;
  }
}

/**
 * Разобрать нажатие. Смотрит и на состояние (режим и начатые нажатия), и на саму клавишу.
 * Служебные клавиши (Ctrl/Cmd) не трогаем: кроме Ctrl+r (повтор) они идут обычным путём.
 */
export function vimKey(chord: KeyChord, state: VimState): VimStep {
  const { key } = chord;
  const control = chord.ctrl === true || chord.meta === true;

  // Ждём символ для `r`: любой знак заменяет знак под кареткой, Escape отменяет.
  if (state.awaitChar === 'replace') {
    if (key === 'Escape') return run({ kind: 'mode', mode: 'normal' }, reset(state));
    return run({ kind: 'replaceChar', char: key, count: state.count || 1 }, reset(state));
  }

  // Ждём объект текста (`iw`/`aw`) после оператора.
  if (state.awaitTextObject) {
    const around = state.awaitTextObject === 'around';
    if (key === 'w' || key === 'W') {
      const operator = state.operator ?? 'delete';
      return run(
        { kind: 'operator', operator, motion: around ? 'aWord' : 'innerWord', count: state.count || 1 },
        reset(state),
      );
    }
    return wait(reset(state));
  }

  // Нажато `g` — ждём `gg` (начало файла). Иначе приставка гасится.
  if (state.gPending) {
    if (key === 'g') {
      return run({ kind: 'motion', motion: 'docStart', count: state.count || 1 }, reset(state));
    }
    return wait(reset(state));
  }

  // Ctrl/Cmd: только Ctrl+r повторяем; остальное — обычным путём (копирование, отмена…).
  if (control) {
    if (key === 'r') return run({ kind: 'redo' }, reset(state));
    return { kind: 'pass' };
  }

  // Счётчик. `0` продолжает число, только если число уже начато; иначе это движение.
  if (key.length === 1 && key >= '1' && key <= '9') {
    return wait({ ...state, count: state.count * 10 + Number(key) });
  }
  if (key === '0' && state.count > 0) {
    return wait({ ...state, count: state.count * 10 });
  }

  if (state.mode === 'visual' || state.mode === 'visual-line') return vimVisualKey(chord, state);
  return vimNormalKey(chord, state);
}

/** Клавиши нормального режима. */
function vimNormalKey(chord: KeyChord, state: VimState): VimStep {
  const { key } = chord;

  // Именованные клавиши — движения и удаление; остальные (F-клавиши и т.п.) пропускаем.
  const named = namedMotion(key);
  if (named) return run({ kind: 'motion', motion: named, count: state.count || 1 }, reset(state));
  if (key === 'Backspace') return run({ kind: 'motion', motion: 'charLeft', count: state.count || 1 }, reset(state));
  if (key === 'Delete') return run({ kind: 'deleteChar', count: state.count || 1 }, reset(state));
  if (key === 'Escape') return run({ kind: 'mode', mode: 'normal' }, reset(state));
  if (key.length > 1) return { kind: 'pass' };

  // Оператор или движение — смотря что нажато раньше.
  if (state.operator === null) {
    if (key === 'd') return wait({ ...state, operator: 'delete', operatorCount: state.count, count: 0 });
    if (key === 'c') return wait({ ...state, operator: 'change', operatorCount: state.count, count: 0 });
    if (key === 'y') return wait({ ...state, operator: 'yank', operatorCount: state.count, count: 0 });
  } else {
    const operator = state.operator;
    const letter = operator === 'delete' ? 'd' : operator === 'change' ? 'c' : 'y';
    const total = (state.operatorCount || 1) * (state.count || 1);
    // Удвоение оператора (`dd`, `cc`, `yy`) — работа со строками целиком.
    if (key === letter) return run({ kind: 'operatorLines', operator, count: total }, reset(state));
    // Объект текста: `iw`, `aw` (внутри слова и вокруг него).
    if (key === 'i') return wait({ ...state, awaitTextObject: 'inner' });
    if (key === 'a') return wait({ ...state, awaitTextObject: 'around' });
    const motion = motionForKey(key);
    if (motion) return run({ kind: 'operator', operator, motion, count: total }, reset(state));
    // Оператор не к месту — гасим.
    return wait(reset(state));
  }

  const count = state.count || 1;
  const motion = motionForKey(key);
  if (motion) return run({ kind: 'motion', motion, count }, reset(state));

  switch (key) {
    case 'x':
      return run({ kind: 'deleteChar', count }, reset(state));
    case 'X':
      return run({ kind: 'deleteCharBefore', count }, reset(state));
    case 'D':
      return run({ kind: 'deleteToEnd', change: false }, reset(state));
    case 'C':
      return run({ kind: 'deleteToEnd', change: true }, reset(state));
    case 'p':
      return run({ kind: 'put', after: true, count }, reset(state));
    case 'P':
      return run({ kind: 'put', after: false, count }, reset(state));
    case 'u':
      return run({ kind: 'undo' }, reset(state));
    case '.':
      return run({ kind: 'repeat' }, reset(state));
    case '/':
      return run({ kind: 'search', forward: true }, reset(state));
    case '?':
      return run({ kind: 'search', forward: false }, reset(state));
    case 'n':
      return run({ kind: 'searchRepeat', same: true }, reset(state));
    case 'N':
      return run({ kind: 'searchRepeat', same: false }, reset(state));
    case 'J':
      return run({ kind: 'join', count }, reset(state));
    case '~':
      return run({ kind: 'toggleCase', count }, reset(state));
    case 'i':
      return run({ kind: 'enterInsert', at: 'before' }, reset(state, 'insert'));
    case 'a':
      return run({ kind: 'enterInsert', at: 'after' }, reset(state, 'insert'));
    case 'I':
      return run({ kind: 'enterInsert', at: 'lineStart' }, reset(state, 'insert'));
    case 'A':
      return run({ kind: 'enterInsert', at: 'lineEnd' }, reset(state, 'insert'));
    case 'o':
      return run({ kind: 'enterInsert', at: 'newLineBelow' }, reset(state, 'insert'));
    case 'O':
      return run({ kind: 'enterInsert', at: 'newLineAbove' }, reset(state, 'insert'));
    case 'r':
      return wait({ ...state, awaitChar: 'replace' });
    case 'g':
      return wait({ ...state, gPending: true });
    case 'v':
      return run({ kind: 'mode', mode: 'visual' }, reset(state, 'visual'));
    case 'V':
      return run({ kind: 'mode', mode: 'visual-line' }, reset(state, 'visual-line'));
    default:
      // Неизвестную печатную клавишу в нормальном режиме гасим (никакого ввода).
      return wait(reset(state));
  }
}

/** Клавиши визуального режима: движения тянут выделение, операторы работают с ним. */
function vimVisualKey(chord: KeyChord, state: VimState): VimStep {
  const { key } = chord;

  if (key === 'Escape' || key === 'v') return run({ kind: 'mode', mode: 'normal' }, reset(state));
  if (key === 'V') {
    const next: VimMode = state.mode === 'visual-line' ? 'visual' : 'visual-line';
    return run({ kind: 'mode', mode: next }, reset(state, next));
  }
  if (key === 'd' || key === 'x') return run({ kind: 'operatorSelection', operator: 'delete' }, reset(state));
  if (key === 'c') return run({ kind: 'operatorSelection', operator: 'change' }, reset(state));
  if (key === 'y') return run({ kind: 'operatorSelection', operator: 'yank' }, reset(state));
  if (key === 'o') return run({ kind: 'swapEnds' }, reset(state));
  if (key === 'J') return run({ kind: 'join', count: state.count || 1 }, reset(state));
  if (key === '~') return run({ kind: 'toggleCase', count: state.count || 1 }, reset(state));
  if (key === 'u') return run({ kind: 'undo' }, reset(state));

  const named = namedMotion(key);
  if (named) return run({ kind: 'motion', motion: named, count: state.count || 1 }, reset(state));
  if (key.length > 1) return { kind: 'pass' };

  const motion = motionForKey(key);
  if (motion) return run({ kind: 'motion', motion, count: state.count || 1 }, reset(state));
  return wait(reset(state));
}

// — движения и участки по тексту —

/** Слово или промежуток в строке. `word` — это слово (для `w`/`b`/`e`). */
interface WordSegment {
  readonly start: number;
  readonly end: number;
  readonly word: boolean;
}

/** Слова и промежутки: маленькое слово — как их видит система (буквы, цифры, `_`). */
function smallSegments(text: string): WordSegment[] {
  return wordSegments(text).map((part) => ({ start: part.start, end: part.end, word: part.isWordLike }));
}

/** Большое слово (WORD): непрерывная полоса непробельных знаков. */
function bigSegments(text: string): WordSegment[] {
  const out: WordSegment[] = [];
  let index = 0;
  while (index < text.length) {
    const space = text[index] === ' ' || text[index] === '\t';
    let end = index + 1;
    while (end < text.length && (text[end] === ' ' || text[end] === '\t') === space) end += 1;
    out.push({ start: index, end, word: !space });
    index = end;
  }
  return out;
}

/** Первый непробельный знак строки — куда ведёт `^`. */
function firstNonBlank(text: string): number {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== ' ' && text[index] !== '\t') return index;
  }
  return 0;
}

/** Стоит ли на позиции слово (по готовым отрезкам). */
function atWord(parts: readonly WordSegment[], index: number): boolean {
  for (const part of parts) if (index >= part.start && index < part.end) return part.word;
  return false;
}

/** Начало первого слова следующей строки (или переданный запасной вариант). */
function nextLineFirst(buffer: TextBuffer, line: number, fallback: number): number {
  if (line < buffer.lineCount) {
    const start = buffer.lineStart(line + 1);
    return start + firstNonBlank(buffer.lineText(line + 1));
  }
  return fallback;
}

/** `w`/`W`: к началу следующего слова. */
function wordForward(buffer: TextBuffer, offset: number, segments: (text: string) => WordSegment[]): number {
  const line = buffer.lineAt(offset);
  const start = buffer.lineStart(line);
  const text = buffer.lineText(line);
  const column = offset - start;
  if (column >= text.length) return nextLineFirst(buffer, line, offset);

  const parts = segments(text);
  let index = column;
  const current = parts.find((part) => column >= part.start && column < part.end);
  if (current?.word) index = current.end;
  while (index < text.length && !atWord(parts, index)) index += 1;
  if (index < text.length) return start + index;
  return nextLineFirst(buffer, line, start + text.length);
}

/** `b`/`B`: к началу предыдущего слова. */
function wordBackward(buffer: TextBuffer, offset: number, segments: (text: string) => WordSegment[]): number {
  const line = buffer.lineAt(offset);
  const start = buffer.lineStart(line);
  const text = buffer.lineText(line);
  const column = offset - start;
  if (column <= 0) {
    if (line > 1) {
      const prevStart = buffer.lineStart(line - 1);
      const parts = segments(buffer.lineText(line - 1));
      for (let index = parts.length - 1; index >= 0; index -= 1) {
        if (parts[index]!.word) return prevStart + parts[index]!.start;
      }
      return prevStart;
    }
    return offset;
  }
  const parts = segments(text);
  let index = column;
  while (index > 0 && !atWord(parts, index - 1)) index -= 1;
  while (index > 0 && atWord(parts, index - 1)) index -= 1;
  return start + index;
}

/** `e`/`E`: к последнему знаку (следующего) слова. Стоим на знаке, а не за ним. */
function wordEnd(buffer: TextBuffer, offset: number, segments: (text: string) => WordSegment[]): number {
  const line = buffer.lineAt(offset);
  const start = buffer.lineStart(line);
  const text = buffer.lineText(line);
  const column = offset - start;
  const parts = segments(text);
  const current = parts.find((part) => part.word && column >= part.start && column < part.end);
  if (current && column < current.end - 1) return start + current.end - 1;
  const next = parts.find((part) => part.word && part.start > column);
  if (next) return start + next.end - 1;
  // Слов правее нет — идём по строкам вниз к первому слову.
  for (let l = line + 1; l <= buffer.lineCount; l += 1) {
    const found = segments(buffer.lineText(l)).find((part) => part.word);
    if (found) return buffer.lineStart(l) + found.end - 1;
  }
  return offset;
}

/** Длина одного знака (кластера) на смещении — для оператора, включающего знак. */
function graphemeLengthAt(buffer: TextBuffer, offset: number): number {
  const line = buffer.lineAt(offset);
  const start = buffer.lineStart(line);
  const text = buffer.lineText(line);
  const local = offset - start;
  if (local >= text.length) return 0;
  const cluster = graphemeAt(text, local);
  return cluster.end - cluster.start;
}

/** Один шаг движения: куда сдвинуться. */
function stepMotion(
  buffer: TextBuffer,
  offset: number,
  motion: VimMotion,
  goal: number,
): { offset: number; goal: number } {
  switch (motion) {
    case 'charLeft':
      return { offset: charLeft(buffer, offset), goal };
    case 'charRight':
      return { offset: charRight(buffer, offset), goal };
    case 'lineDown':
      return { offset: moveVertical(buffer, offset, 1, goal), goal };
    case 'lineUp':
      return { offset: moveVertical(buffer, offset, -1, goal), goal };
    case 'wordForward':
      return { offset: wordForward(buffer, offset, smallSegments), goal };
    case 'wordBackward':
      return { offset: wordBackward(buffer, offset, smallSegments), goal };
    case 'wordEnd':
      return { offset: wordEnd(buffer, offset, smallSegments), goal };
    case 'bigWordForward':
      return { offset: wordForward(buffer, offset, bigSegments), goal };
    case 'bigWordBackward':
      return { offset: wordBackward(buffer, offset, bigSegments), goal };
    case 'bigWordEnd':
      return { offset: wordEnd(buffer, offset, bigSegments), goal };
    case 'lineStart':
      return { offset: buffer.lineStart(buffer.lineAt(offset)), goal };
    case 'lineFirstNonBlank': {
      const line = buffer.lineAt(offset);
      return { offset: buffer.lineStart(line) + firstNonBlank(buffer.lineText(line)), goal };
    }
    case 'lineEnd': {
      const line = buffer.lineAt(offset);
      return { offset: buffer.lineStart(line) + buffer.lineText(line).length, goal };
    }
    case 'docStart':
      return { offset: 0, goal };
    case 'docEnd': {
      const line = buffer.lineCount;
      return { offset: buffer.lineStart(line) + firstNonBlank(buffer.lineText(line)), goal };
    }
    case 'innerWord':
    case 'aWord':
      return { offset, goal };
  }
}

/** Горизонтальное ли движение: у него желаемый столбец берётся заново. */
export function isHorizontalMotion(motion: VimMotion): boolean {
  return motion !== 'lineDown' && motion !== 'lineUp' && motion !== 'docStart' && motion !== 'docEnd';
}

/** `h`: знак влево, но не за начало строки. */
function charLeft(buffer: TextBuffer, offset: number): number {
  const line = buffer.lineAt(offset);
  const start = buffer.lineStart(line);
  if (offset <= start) return offset;
  return start + previousGraphemeBoundary(buffer.lineText(line), offset - start);
}

/** `l`: знак вправо, но не за конец строки. */
function charRight(buffer: TextBuffer, offset: number): number {
  const line = buffer.lineAt(offset);
  const start = buffer.lineStart(line);
  const text = buffer.lineText(line);
  const column = offset - start;
  if (column >= text.length) return offset;
  return start + nextGraphemeBoundary(text, column);
}

/** Куда переехать курсору: движение, повторённое `count` раз (goal — желаемый столбец). */
export function vimMoveTarget(
  buffer: TextBuffer,
  offset: number,
  motion: VimMotion,
  count: number,
  goal = 0,
): { offset: number; goal: number } {
  let at = offset;
  let currentGoal = goal;
  const times = Math.max(1, count);
  for (let step = 0; step < times; step += 1) {
    const next = stepMotion(buffer, at, motion, currentGoal);
    if (next.offset === at) {
      currentGoal = next.goal;
      break;
    }
    at = next.offset;
    currentGoal = next.goal;
  }
  return { offset: at, goal: currentGoal };
}

/** Участок для оператора: что он захватывает. `linewise` — строки целиком. */
export interface VimRange {
  readonly start: number;
  readonly end: number;
  readonly linewise: boolean;
}

/** Объект текста (`iw`/`aw`): слово под кареткой (или ближайшее справа). */
function textObject(buffer: TextBuffer, offset: number, around: boolean): VimRange {
  const line = buffer.lineAt(offset);
  const start = buffer.lineStart(line);
  const text = buffer.lineText(line);
  const column = offset - start;
  const parts = smallSegments(text);
  const word =
    parts.find((part) => part.word && column >= part.start && column < part.end) ??
    parts.find((part) => part.word && part.start >= column);
  if (!word) return { start: offset, end: offset, linewise: false };
  let from = start + word.start;
  let to = start + word.end;
  if (around) {
    const after = /^[ \t]+/.exec(text.slice(word.end));
    if (after) to = start + word.end + after[0].length;
    else {
      const before = /[ \t]+$/.exec(text.slice(0, word.start));
      if (before) from = start + word.start - before[0].length;
    }
  }
  return { start: from, end: to, linewise: false };
}

/**
 * Участок, который захватит оператор вместе с движением.
 * Правило включительности: `e`/`E` захватывают последний знак слова, `$` уже стоит за
 * последним знаком строки, вертикальные движения и `gg`/`G` — построчно.
 */
export function vimMotionRange(buffer: TextBuffer, offset: number, motion: VimMotion, count: number): VimRange {
  if (motion === 'innerWord' || motion === 'aWord') return textObject(buffer, offset, motion === 'aWord');

  // Построчные движения: захватывают строки целиком.
  if (motion === 'lineDown' || motion === 'lineUp' || motion === 'docStart' || motion === 'docEnd') {
    const fromLine = buffer.lineAt(offset);
    const target = vimMoveTarget(buffer, offset, motion, count, 0).offset;
    const toLine = buffer.lineAt(target);
    const top = Math.min(fromLine, toLine);
    const bottom = Math.max(fromLine, toLine);
    const start = buffer.lineStart(top);
    const end = bottom < buffer.lineCount ? buffer.lineStart(bottom + 1) : buffer.length;
    return { start, end, linewise: true };
  }

  const target = vimMoveTarget(buffer, offset, motion, count, 0).offset;
  const inclusive = motion === 'wordEnd' || motion === 'bigWordEnd';
  if (target >= offset) {
    const end = inclusive && target > offset ? target + graphemeLengthAt(buffer, target) : target;
    return { start: offset, end, linewise: false };
  }
  return { start: target, end: offset, linewise: false };
}

/** Смена регистра знака: большая ↔ маленькая. */
export function toggleCaseText(text: string): string {
  let out = '';
  for (const char of text) {
    const lower = char.toLowerCase();
    out += char === lower ? char.toUpperCase() : lower;
  }
  return out;
}
