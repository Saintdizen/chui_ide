/**
 * Раскладка клавиш: какая клавиша что делает.
 *
 * Отдельным чистым модулем, а не россыпью `if` в обработчике событий, по двум
 * причинам. Первая: раскладку надо проверять — а событие клавиатуры в тесте без окна
 * не поднять, а вот объект `{ key, shift, ctrl }` — легко. Вторая: список команд
 * получается ОДИН, и по нему же строится справка «горячие клавиши» и подсказки, а не
 * живёт в голове у того, кто читает обработчик.
 *
 * Здесь только перевод клавиши в команду — никаких правок и движений. Что команда
 * делает, решает контроллер. Так раскладку можно менять, не трогая поведение.
 *
 * Пользуемся `event.key` (а не `code`): он учитывает раскладку и уже готовый символ
 * с модификатором (Shift+«1» даёт «!»). Для движений и управления этого достаточно;
 * физические клавиши (`code`) понадобились бы только для своих привязок вроде игровых.
 */

/** Раскладка раскладки — то, что нужно знать о нажатии. Меньше, чем `KeyboardEvent`: так проще проверять. */
export interface KeyChord {
  /** Значение `KeyboardEvent.key`: «a», «ArrowLeft», «Home», «\n» и так далее. */
  readonly key: string;
  readonly shift?: boolean;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly alt?: boolean;
}

/** Что делать с нажатием. `null` — клавиша нас не касается, пусть решает браузер. */
export type KeyAction =
  | { readonly kind: 'move'; readonly motion: Motion; readonly extend: boolean }
  | { readonly kind: 'edit'; readonly edit: EditCommand }
  | { readonly kind: 'insert'; readonly text: string }
  /** Обработано нами, но реакции нет: например, Ctrl без смысла — гасим, чтобы не прилетело в textarea. */
  | { readonly kind: 'swallow' };

/** Движения курсора, которые понимает контроллер. */
export type Motion =
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'wordLeft'
  | 'wordRight'
  | 'lineStart'
  | 'smartLineStart'
  | 'lineEnd'
  | 'docStart'
  | 'docEnd'
  | 'pageUp'
  | 'pageDown';

/** Правки и команды, которые контроллер выполняет целиком. */
export type EditCommand =
  | 'newline'
  | 'backspace'
  | 'delete'
  | 'deleteWordBackward'
  | 'deleteWordForward'
  | 'indent'
  | 'outdent'
  | 'undo'
  | 'redo'
  | 'selectAll'
  | 'copy'
  | 'cut'
  | 'paste'
  | 'find'
  | 'replace'
  | 'gotoLine'
  /** Ctrl+/ — закомментировать или расскомментировать строки. */
  | 'toggleComment'
  /** Alt+↑/↓ — перенести строку; Shift+Alt+↓ — скопировать её ниже. */
  | 'moveLineUp'
  | 'moveLineDown'
  | 'copyLineDown'
  /** Shift+Alt+A — блочный комментарий; Ctrl+Shift+K — удалить строку целиком. */
  | 'toggleBlockComment'
  | 'deleteLine'
  /** Ctrl+Shift+J — соединить строки; Ctrl+Enter и Ctrl+Shift+Enter — вставить строку ниже/выше. */
  | 'joinLines'
  | 'insertLineBelow'
  | 'insertLineAbove'
  /** F1 — палитра команд (у Monaco её открывало его же действие). */
  | 'palette'
  /** Ctrl+. — быстрые исправления под курсором (список показывает приложение). */
  | 'codeActions'
  /** Ctrl+D — добавить следующее вхождение слова; Ctrl+Shift+L — сразу все. */
  | 'selectNextOccurrence'
  | 'selectAllOccurrences'
  /** Ctrl+Alt+↑/↓ — каретка на строку выше или ниже (столбец кареток). */
  | 'addCursorAbove'
  | 'addCursorBelow'
  /** Escape — оставить только главную каретку после мультикурсора. */
  | 'collapseSelections'
  /** Ctrl+Shift+[ и Ctrl+Shift+] — свернуть и развернуть блок у курсора. */
  | 'fold'
  | 'unfold'
  /**
   * Навигация по символу: F12 — перейти к определению, Shift+F12 — ссылки,
   * Ctrl+Shift+F12 — заглянуть в определение, не уходя из файла. Показывает их
   * вызывающий (у него и языковой сервер, и открытие файлов).
   */
  | 'goToDefinition'
  | 'references'
  | 'peekDefinition';

/**
 * Во что превращается нажатие.
 *
 * Порядок разбора важен: сначала служебные клавиши (у них есть `key`-имя), и только
 * в конце — печатный символ. Иначе буква «a» с Ctrl попала бы в ввод текста.
 */
export function resolveKey(chord: KeyChord): KeyAction | null {
  const extend = chord.shift === true;
  const control = chord.ctrl === true || chord.meta === true;
  const { key } = chord;

  // Разделители строк: разные раскладки и системы дают разные имена.
  if (key === 'Enter' || key === '\r' || key === '\n') {
    if (chord.alt) return null;
    // Ctrl+Enter вставляет строку НИЖЕ, Ctrl+Shift+Enter — ВЫШЕ. Без Ctrl — обычный перевод.
    if (control) return { kind: 'edit', edit: extend ? 'insertLineAbove' : 'insertLineBelow' };
    return { kind: 'edit', edit: 'newline' };
  }
  if (key === 'Backspace') {
    return { kind: 'edit', edit: control ? 'deleteWordBackward' : 'backspace' };
  }
  if (key === 'Delete') {
    return { kind: 'edit', edit: control ? 'deleteWordForward' : 'delete' };
  }
  if (key === 'Tab') {
    // Shift+Tab снимает отступ со строки (один таб или до `tabSize` пробелов).
    return { kind: 'edit', edit: extend ? 'outdent' : 'indent' };
  }
  // F1 — палитра команд: у Monaco её открывало его же действие, своему редактору
  // нужна своя обработка. Сочетания клавиш у неё нет — это клавиша панели.
  if (key === 'F1') return { kind: 'edit', edit: 'palette' };
  // Навигация по символу: F12 — определение, Shift+F12 — ссылки, Ctrl+Shift+F12 —
  // заглянуть (определение на месте). Привычные клавиши из VS Code и PyCharm.
  if (key === 'F12') {
    if (control && extend) return { kind: 'edit', edit: 'peekDefinition' };
    return { kind: 'edit', edit: extend ? 'references' : 'goToDefinition' };
  }
  // Escape после мультикурсора оставляет одну каретку — как в других редакторах.
  if (key === 'Escape') return { kind: 'edit', edit: 'collapseSelections' };

  if (key === 'ArrowLeft') return motion(control ? 'wordLeft' : 'left', extend);
  if (key === 'ArrowRight') return motion(control ? 'wordRight' : 'right', extend);
  // Ctrl+Alt+↑/↓ добавляет каретку на соседнюю строку — проверяем раньше переноса строк
  // (Alt+↑), иначе сочеталось бы с переносом.
  if (control && chord.alt) {
    if (key === 'ArrowUp') return { kind: 'edit', edit: 'addCursorAbove' };
    if (key === 'ArrowDown') return { kind: 'edit', edit: 'addCursorBelow' };
  }
  // Alt со стрелками переносит и копирует строки — проверяем раньше обычного хода
  // курсора, иначе Alt+↑ ничем не отличался бы от ↑.
  if (chord.alt) {
    if (key === 'ArrowUp') return { kind: 'edit', edit: 'moveLineUp' };
    if (key === 'ArrowDown') return { kind: 'edit', edit: extend ? 'copyLineDown' : 'moveLineDown' };
    // Shift+Alt+A — блочный комментарий: знак пары берётся по языку на стороне ввода.
    if (extend && key.toLowerCase() === 'a') return { kind: 'edit', edit: 'toggleBlockComment' };
  }
  if (key === 'ArrowUp') return motion('up', extend);
  if (key === 'ArrowDown') return motion('down', extend);
  if (key === 'PageUp') return motion('pageUp', extend);
  if (key === 'PageDown') return motion('pageDown', extend);

  if (key === 'Home') return motion(control ? 'docStart' : 'smartLineStart', extend);
  if (key === 'End') return motion(control ? 'docEnd' : 'lineEnd', extend);

  if (control) {
    const lower = key.toLowerCase();
    if (lower === 'a') return { kind: 'edit', edit: 'selectAll' };
    if (lower === 'c') return { kind: 'edit', edit: 'copy' };
    if (lower === 'x') return { kind: 'edit', edit: 'cut' };
    if (lower === 'v') return { kind: 'edit', edit: 'paste' };
    if (lower === 'f') return { kind: 'edit', edit: 'find' };
    if (lower === 'h') return { kind: 'edit', edit: 'replace' };
    if (lower === 'g') return { kind: 'edit', edit: 'gotoLine' };
    // Ctrl+D — следующее вхождение слова, Ctrl+Shift+L — все вхождения сразу.
    if (lower === 'd') return { kind: 'edit', edit: 'selectNextOccurrence' };
    if (lower === 'l' && extend) return { kind: 'edit', edit: 'selectAllOccurrences' };
    // Ctrl+Shift+K — удалить строку; Ctrl+Shift+J — соединить строки в одну.
    if (lower === 'k' && extend) return { kind: 'edit', edit: 'deleteLine' };
    if (lower === 'j' && extend) return { kind: 'edit', edit: 'joinLines' };
    // Ctrl+/ — комментарий строки: буквенного имени у клавиши нет, проверяем сам знак.
    if (key === '/') return { kind: 'edit', edit: 'toggleComment' };
    // Ctrl+. — быстрые исправления: как в других редакторах, на той же клавише.
    if (key === '.') return { kind: 'edit', edit: 'codeActions' };
    // Ctrl+Shift+[ сворачивает блок, Ctrl+Shift+] раскрывает — как в других редакторах.
    // Со сдвигом те же клавиши дают «{» и «}»: раскладка меняет знак, команда — та же.
    if (key === '[' || key === '{') return { kind: 'edit', edit: 'fold' };
    if (key === ']' || key === '}') return { kind: 'edit', edit: 'unfold' };
    // Ctrl+Z — отмена; Ctrl+Shift+Z и Ctrl+Y — повтор (обе привычки поддержаны).
    if (lower === 'z') return { kind: 'edit', edit: extend ? 'redo' : 'undo' };
    if (lower === 'y') return { kind: 'edit', edit: 'redo' };
    return { kind: 'swallow' };
  }

  // Печатный символ: одна кодовая точка, не управляющий. Ввод идёт сюда только когда
  // нет Ctrl/Alt — иначе это была бы команда. Meta на macOS трогать не даём тоже.
  if (!chord.alt && typeof key === 'string' && key.length > 0 && isPrintable(key)) {
    return { kind: 'insert', text: key };
  }

  return null;
}

function motion(kind: Motion, extend: boolean): KeyAction {
  return { kind: 'move', motion: kind, extend };
}

/**
 * Печатный ли это символ. Отсекаем управляющие (длина 1, но код меньше пробела) и
 * многочисленные служебные имена вроде «F5» или «Shift»: у них `key` длиннее одного
 * символа (кроме редких, но их отсекает проверка на управляющие коды).
 */
function isPrintable(key: string): boolean {
  if (key.length === 1) {
    const code = key.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f;
  }
  // Составные эмодзи (две и более единицы UTF-16) — тоже печатные.
  return Array.from(key).length === 1 && (key.codePointAt(0) ?? 0) >= 0x20;
}

/** Есть ли у клавиши модификатор, который мы не поддерживаем как имя команды. */
export function isModified(chord: KeyChord): boolean {
  return chord.ctrl === true || chord.meta === true || chord.alt === true;
}
