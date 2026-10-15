/**
 * Emacs-раскладка: разбор сочетаний клавиш в команды. Чистая логика, без DOM.
 *
 * В отличие от Vim-режима (`vim.ts`), здесь редактор НЕ модальный: обычные буквы всегда
 * печатают текст, а командами становятся только сочетания с Ctrl (управление) и Alt
 * (в Emacs это Meta). Перевод нажатия в команду живёт отдельно от событий браузера —
 * так раскладка проверяется в Node без окна.
 *
 * Что взято из привычек Emacs:
 *
 *   • Ctrl+F/B — знак вперёд/назад, Ctrl+N/P — строка вниз/вверх, Ctrl+A/E — начало/конец строки.
 *   • Ctrl+D — удалить знак вперёд, Ctrl+H — назад.
 *   • Ctrl+K — «убить» до конца строки (или перевод строки в конце), Ctrl+U — до начала строки.
 *   • Ctrl+Y — вставить («yank») последнее убитое, Alt+Y — прокрутить кольцо убитого
 *     (заменить только что вставленное на предыдущее убитое).
 *   • Ctrl+_ — отмена.
 *   • Ctrl+Space — поставить метку (начать выделение), Ctrl+G — сбросить.
 *   • Ctrl+T — переставить знаки, Ctrl+O — вставить строку, оставив каретку перед ней.
 *   • Alt+F/B — по словам, Alt+D — убить слово вперёд, Alt+Backspace — назад,
 *     Alt+&lt;/Alt+&gt; — начало/конец файла.
 *
 * Намеренно НЕ трогаем системные сочетания, к которым привык GUI: Ctrl+C/X/V (копирование и
 * вставка), Ctrl+Z, Ctrl+S. Их обрабатывают обычный ввод и меню — иначе Emacs-режим ломал бы
 * привычное всем поведение.
 */

import type { KeyChord } from './keymap';

/** Движение курсора в терминах Emacs. Совпадает с общим набором движений редактора. */
export type EmacsMotion =
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'wordLeft'
  | 'wordRight'
  | 'lineStart'
  | 'lineEnd'
  | 'docStart'
  | 'docEnd';

/** Разобранная команда Emacs: слой-исполнитель её применяет. */
export type EmacsCommand =
  | { readonly kind: 'move'; readonly motion: EmacsMotion }
  /** Ctrl+D — удалить знак вперёд. */
  | { readonly kind: 'deleteForward' }
  /** Ctrl+H — удалить знак назад. */
  | { readonly kind: 'deleteBackward' }
  /** Ctrl+K — убить до конца строки. */
  | { readonly kind: 'killLine' }
  /** Ctrl+U — убить до начала строки. */
  | { readonly kind: 'killToStart' }
  /** Alt+D — убить слово вперёд. */
  | { readonly kind: 'killWordForward' }
  /** Alt+Backspace — убить слово назад. */
  | { readonly kind: 'killWordBackward' }
  /** Ctrl+Y — вставить последнее убитое. */
  | { readonly kind: 'yank' }
  /** Alt+Y — «прокрутить» кольцо убитого: заменить только что вставленное. */
  | { readonly kind: 'yankPop' }
  /** Ctrl+Space — поставить или снять метку. */
  | { readonly kind: 'setMark' }
  /** Ctrl+G — сбросить выделение и метку. */
  | { readonly kind: 'cancel' }
  /** Ctrl+_ — отмена. */
  | { readonly kind: 'undo' }
  /** Ctrl+T — переставить два знака. */
  | { readonly kind: 'transpose' }
  /** Ctrl+O — вставить строку, каретка остаётся перед ней. */
  | { readonly kind: 'openLine' };

/**
 * Что делает сочетание. `null` — нажатие не наше (обычный ввод или системная команда).
 * Смотрим только Ctrl (без Alt) и Alt (без Ctrl): сочетания из двух модификаторов —
 * это уже другие команды редактора.
 */
export function resolveEmacs(chord: KeyChord): EmacsCommand | null {
  const { key } = chord;
  const ctrl = chord.ctrl === true;
  const alt = chord.alt === true;

  if (ctrl && !alt) {
    // Ctrl+Space: клавиша-пробел приходит как « ».
    if (key === ' ') return { kind: 'setMark' };
    if (key === '_') return { kind: 'undo' };
    if (key.length !== 1) return null;
    switch (key.toLowerCase()) {
      case 'f':
        return move('right');
      case 'b':
        return move('left');
      case 'n':
        return move('down');
      case 'p':
        return move('up');
      case 'a':
        return move('lineStart');
      case 'e':
        return move('lineEnd');
      case 'd':
        return { kind: 'deleteForward' };
      case 'h':
        return { kind: 'deleteBackward' };
      case 'k':
        return { kind: 'killLine' };
      case 'u':
        return { kind: 'killToStart' };
      case 'y':
        return { kind: 'yank' };
      case 'g':
        return { kind: 'cancel' };
      case 't':
        return { kind: 'transpose' };
      case 'o':
        return { kind: 'openLine' };
      default:
        return null;
    }
  }

  if (alt && !ctrl) {
    if (key === 'Backspace') return { kind: 'killWordBackward' };
    if (key === '<') return move('docStart');
    if (key === '>') return move('docEnd');
    if (key.length !== 1) return null;
    switch (key.toLowerCase()) {
      case 'f':
        return move('wordRight');
      case 'b':
        return move('wordLeft');
      case 'd':
        return { kind: 'killWordForward' };
      case 'y':
        return { kind: 'yankPop' };
      default:
        return null;
    }
  }

  return null;
}

function move(motion: EmacsMotion): EmacsCommand {
  return { kind: 'move', motion };
}
