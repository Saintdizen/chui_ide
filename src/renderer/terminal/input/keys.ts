/**
 * Клавиатура терминала: событие клавиши → байты для pty.
 *
 * Оболочка ждёт не «нажата стрелка вправо», а последовательность `\x1b[C`. Управляющие
 * комбинации (`Ctrl+C` — `\x03`), функциональные клавиши, `Home`/`End`, стрелки — всем
 * им соответствуют свои байты в стандарте терминала. Правило чистое (событие → строка),
 * поэтому проверяется тестами без окна и без pty.
 *
 * Два режима меняют кодирование:
 *   • «прикладные» стрелки (`DECCKM`): вместо `\x1b[A` шлётся `\x1bOA` — это просит
 *     полноэкранная программа вроде `vim` — то, что она умеет разобрать;
 *   • вставка со скобками (bracketed paste): вставленный текст обрамляется маркерами,
 *     чтобы редактор не принял его за набранные команды.
 */

import { physicalKeyName } from '../../../shared/physical-key';

/** Что известно о нажатии: клавиша и модификаторы (как у `KeyboardEvent`). */
export interface KeyStroke {
  readonly key: string;
  /**
   * `KeyboardEvent.code` — физическая клавиша. По ней считаются управляющие коды и
   * сочетания: при русской раскладке `Ctrl+C` даёт `key === 'с'`, и в pty ушёл бы
   * символ вместо сигнала `\x03`.
   */
  readonly code?: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

/** Режимы, влияющие на кодирование. */
export interface KeyModes {
  readonly applicationCursorKeys: boolean;
}

/** Стрелки и навигация: модификатор `1;N` где `N` — битовая маска (Shift=1, Alt=2, Ctrl=4). */
const NAVIGATION: Record<string, { normal: string; application?: string }> = {
  ArrowUp: { normal: 'A', application: 'A' },
  ArrowDown: { normal: 'B', application: 'B' },
  ArrowRight: { normal: 'C', application: 'C' },
  ArrowLeft: { normal: 'D', application: 'D' },
  Home: { normal: 'H' },
  End: { normal: 'F' },
};

/** Функциональные клавиши и редкие навигационные: свои последовательности. */
const FUNCTION_KEYS: Record<string, string> = {
  Insert: '\x1b[2~',
  Delete: '\x1b[3~',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
  F1: '\x1bOP',
  F2: '\x1bOQ',
  F3: '\x1bOR',
  F4: '\x1bOS',
  F5: '\x1b[15~',
  F6: '\x1b[17~',
  F7: '\x1b[18~',
  F8: '\x1b[19~',
  F9: '\x1b[20~',
  F10: '\x1b[21~',
  F11: '\x1b[23~',
  F12: '\x1b[24~',
};

/** Модификатор-параметр CSI для навигации: `0` — без модификаторов, иначе битовая маска плюс один. */
function modifierParam(stroke: KeyStroke): number {
  return (stroke.shiftKey ? 1 : 0) + (stroke.altKey ? 2 : 0) + (stroke.ctrlKey ? 4 : 0) + 1;
}

/** Код управляющего символа для `Ctrl+<буква>` и родственных: `Ctrl+A` → 1, `Ctrl+[` → 27. */
function controlCode(key: string): number | null {
  if (key === ' ') return 0;
  if (key === '[' || key === '3') return 27;
  if (key === '\\' || key === '4') return 28;
  if (key === ']' || key === '5') return 29;
  if (key === '^' || key === '6') return 30;
  if (key === '_' || key === '7' || key === '/') return 31;
  if (key === '8' || key === '?') return 127;
  const lower = key.toLowerCase();
  if (lower.length === 1 && lower >= 'a' && lower <= 'z') return lower.charCodeAt(0) - 96;
  return null;
}

/**
 * Байты для одного нажатия. `null` — клавишу не кодируем (пусть решает браузер или
 * вызывающая сторона). Модификаторы разбираются по очереди: `Ctrl` даёт управляющий
 * символ, `Alt` — префикс `ESC`, затем приходит сам знак.
 */
export function encodeKey(stroke: KeyStroke, modes: KeyModes): string | null {
  const { key } = stroke;
  // Управляющий код — по ФИЗИЧЕСКОЙ клавише: `Ctrl+C` при русской раскладке даёт
  // `key === 'с'`, и без этого в pty уходил символ вместо сигнала прерывания.
  const named = stroke.ctrlKey ? (physicalKeyName(stroke.code) ?? key) : key;

  // Навигация: стрелки бывают «обычными» и «прикладными»; прочие — с модификатором.
  const nav = NAVIGATION[key];
  if (nav) {
    const modifier = modifierParam(stroke);
    if (modifier === 1) {
      const final = modes.applicationCursorKeys && nav.application ? `\x1bO${nav.application}` : `\x1b[${nav.normal}`;
      return final;
    }
    // Стрелки вверх/вниз/вправо/влево с модификатором — всегда CSI `1;N`.
    const letter = nav.normal;
    return `\x1b[1;${modifier}${letter}`;
  }

  const fn = FUNCTION_KEYS[key];
  if (fn) return fn;

  switch (key) {
    case 'Enter':
      return '\r';
    case 'Tab':
      return stroke.shiftKey ? '\x1b[Z' : '\t';
    case 'Backspace':
      return stroke.ctrlKey ? '\x08' : '\x7f';
    case 'Escape':
      return '\x1b';
    default:
      break;
  }

  // Обычный знак. Ctrl превращает его в управляющий код, Alt добавляет префикс ESC.
  if (key.length === 1) {
    const base = stroke.ctrlKey ? controlCode(named) : null;
    // Без Ctrl у Alt остаётся символ раскладки: Alt — это префикс ESC к набранному.
    const produced = base !== null ? String.fromCharCode(base) : key;
    return stroke.altKey ? `\x1b${produced}` : produced;
  }

  return null;
}

/**
 * Комбинация вставки: `Ctrl+V` (на macOS — `⌘V`), в том числе с `Shift`.
 *
 * Терминал — не поле ввода, поэтому обработчика `paste` у него не будет: событие
 * приходит только редактируемому элементу. Значит комбинацию ловим сами — иначе
 * `Ctrl+V` уходит в pty управляющим кодом `\x16` (quoted-insert) и ничего не вставляет.
 */
export function isPasteStroke(stroke: KeyStroke): boolean {
  // По физической клавише: при русской раскладке `Ctrl+V` даёт `key === 'м'`.
  const named = physicalKeyName(stroke.code) ?? stroke.key;
  return (stroke.ctrlKey || stroke.metaKey) && !stroke.altKey && named.toLowerCase() === 'v';
}

/**
 * Обрамить вставленный текст маркерами bracketed paste, если режим включён. Без режима
 * текст идёт как есть. Возвращается и признак того, что вставку надо отправить целиком.
 */
export function encodePaste(text: string, bracketed: boolean): string {
  if (!bracketed) return text;
  return `\x1b[200~${text}\x1b[201~`;
}

/** Кнопка мыши: левая, средняя, правая или колесо. */
export type MouseButton = 'left' | 'middle' | 'right' | 'wheelUp' | 'wheelDown' | 'none';

/** Что произошло с мышью: нажатие, отпускание или движение. */
export type MouseAction = 'press' | 'release' | 'move';

/** Одно событие мыши в клетках экрана (0-based) вместе с зажатыми модификаторами. */
export interface MouseEventData {
  readonly action: MouseAction;
  readonly button: MouseButton;
  readonly col: number;
  readonly row: number;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly ctrl: boolean;
}

/** Номер кнопки в протоколе мыши: левая 0, средняя 1, правая 2, колесо вверх/вниз 64/65. */
const BUTTON_CODE: Record<MouseButton, number> = {
  left: 0,
  middle: 1,
  right: 2,
  wheelUp: 64,
  wheelDown: 65,
  none: 3,
};

/**
 * Байты события мыши. Два формата:
 *   • SGR (`?1006`) — числа словами, координаты не ограничены 223 и видно отпускание `m`;
 *   • старый — три байта со смещением 32, поэтому координата дальше 223 не выразима.
 */
export function encodeMouse(event: MouseEventData, sgr: boolean): string {
  let code = BUTTON_CODE[event.button];
  // Движение отмечается битом 32; при перетаскивании он же несёт зажатую кнопку.
  if (event.action === 'move') code += 32;
  if (event.shift) code += 4;
  if (event.alt) code += 8;
  if (event.ctrl) code += 16;
  const col = event.col + 1;
  const row = event.row + 1;

  if (sgr) {
    const final = event.action === 'release' ? 'm' : 'M';
    return `\x1b[<${code};${col};${row}${final}`;
  }
  return `\x1b[M${String.fromCharCode(32 + code)}${String.fromCharCode(32 + col)}${String.fromCharCode(32 + row)}`;
}
