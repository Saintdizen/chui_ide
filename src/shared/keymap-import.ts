import type { KeybindingOverride } from './keybindings';

/**
 * Импорт чужих карт клавиш: `keybindings.json` из VS Code и профиль IDEA.
 *
 * Зачем: человек, переехавший из другой IDE, помнит не названия команд, а
 * пальцы. Перенабирать сотню сочетаний руками — занятие на вечер, и большая
 * часть уходит на те, что и так совпадают.
 *
 * Перевод не бывает полным, и это говорят вслух: у чужой IDE свой набор
 * команд, и половина чужих сочетаний просто не к чему привязать. Поэтому
 * результат несёт и принятое, и отброшенное — молча проглотить половину
 * файла значило бы дать человеку думать, что перенеслось всё.
 */

/** Что из чужого файла удалось понять. */
export interface KeymapImportResult {
  /** Переопределения в нашем формате. */
  overrides: KeybindingOverride[];
  /** Сколько сочетаний было в файле. */
  total: number;
  /** Команды, которым не нашлось пары (чужое имя — как написано у них). */
  unknown: string[];
  /** Ошибка разбора, если файл не прочитался. */
  error?: string;
}

/**
 * Как VS Code зовёт команду — наше имя. Только то, что мы действительно умеем.
 *
 * Список нарочно короткий: привязать `workbench.action.terminal.split` к
 * чему-то похожему, но не тому — хуже, чем не привязать вовсе: человек жмёт
 * привычное и получает не то.
 */
const VSCODE_COMMANDS: Record<string, string> = {
  'workbench.action.showCommands': 'palette.show',
  'workbench.action.quickOpen': 'palette.show',
  'workbench.action.files.save': 'file.save',
  'workbench.action.files.saveAll': 'file.saveAll',
  'workbench.action.files.newUntitledFile': 'file.new',
  'workbench.action.closeActiveEditor': 'file.close',
  'workbench.action.closeAllEditors': 'file.closeAll',
  'workbench.action.nextEditor': 'file.nextTab',
  'workbench.action.previousEditor': 'file.prevTab',
  'editor.action.formatDocument': 'editor.format',
  'editor.action.commentLine': 'editor.toggleComment',
  'editor.action.blockComment': 'editor.toggleBlockComment',
  'editor.action.rename': 'editor.rename',
  'editor.action.quickFix': 'editor.quickFix',
  'editor.action.revealDefinition': 'editor.definition',
  'editor.action.goToReferences': 'editor.references',
  'editor.action.organizeImports': 'editor.organizeImports',
  'actions.find': 'editor.find',
  'editor.action.startFindReplaceAction': 'editor.replace',
  'workbench.action.findInFiles': 'search.project',
  'workbench.action.replaceInFiles': 'search.replaceInProject',
  'workbench.action.toggleSidebarVisibility': 'view.toggleSidebar',
  'workbench.action.togglePanel': 'view.toggleDock',
  'workbench.view.explorer': 'explorer.focus',
  'workbench.action.terminal.toggleTerminal': 'terminal.toggle',
  'workbench.action.terminal.new': 'terminal.new',
  'workbench.action.gotoLine': 'editor.gotoLine',
  'workbench.action.files.revert': 'file.revert',
  'editor.action.transformToUppercase': 'editor.upperCase',
  'editor.action.transformToLowercase': 'editor.lowerCase',
};

/**
 * IDEA: имя действия — наше. IDEA пишет `ctrl alt L`; раскладку переводим в
 * наш вид отдельно.
 */
const IDEA_COMMANDS: Record<string, string> = {
  SaveAll: 'file.saveAll',
  CloseEditor: 'file.close',
  CloseAllEditors: 'file.closeAll',
  ReformatCode: 'editor.format',
  CommentByLineComment: 'editor.toggleComment',
  CommentByBlockComment: 'editor.toggleBlockComment',
  GotoFile: 'palette.showFiles',
  GotoLine: 'editor.gotoLine',
  Find: 'editor.find',
  Replace: 'editor.replace',
  FindInPath: 'search.project',
  ReplaceInPath: 'search.replaceInProject',
  RenameElement: 'editor.rename',
  ShowIntentionActions: 'editor.quickFix',
  GotoDeclaration: 'editor.definition',
  FindUsages: 'editor.references',
  OptimizeImports: 'editor.organizeImports',
  ActivateTerminalToolWindow: 'terminal.toggle',
  ToggleDistractionFreeMode: 'view.zen',
};

/**
 * Разбор `keybindings.json` VS Code.
 *
 * `-команда` у VS Code значит «снять сочетание» — переносим пустой строкой,
 * иначе импорт молча оставил бы сочетание, от которого человек специально
 * избавлялся. `when` не учитываем: условия VS Code (`editorTextFocus` и
 * прочие) к нашей модели не сводятся, и притворяться, что свели, — хуже.
 */
export function importVsCodeKeymap(text: string): KeymapImportResult {
  const parsed = parseJsonC(text);
  if (!Array.isArray(parsed)) {
    return { overrides: [], total: 0, unknown: [], error: 'Ожидался массив в keybindings.json' };
  }

  const overrides: KeybindingOverride[] = [];
  const unknown: string[] = [];
  let total = 0;
  for (const raw of parsed) {
    if (typeof raw !== 'object' || raw === null) continue;
    const key = (raw as { key?: unknown }).key;
    const command = (raw as { command?: unknown }).command;
    if (typeof key !== 'string' || typeof command !== 'string') continue;
    total += 1;

    const remove = command.startsWith('-');
    const name = remove ? command.slice(1) : command;
    const ours = VSCODE_COMMANDS[name];
    if (!ours) {
      unknown.push(name);
      continue;
    }
    const combo = vscodeCombo(key);
    if (combo === null) {
      unknown.push(name);
      continue;
    }
    overrides.push({ command: ours, combo: remove ? '' : combo });
  }
  return { overrides, total, unknown };
}

/**
 * Разбор выгрузки IDEA: XML с `<action id="..."><keyboard-shortcut
 * first-keystroke="ctrl alt L"/></action>`.
 *
 * Без парсера XML: нужна ровно одна вложенность, а тянуть ради неё разборщик
 * в окно — цена больше пользы. `second-keystroke` (два нажатия подряд) не
 * берём — такого у нас нет.
 */
export function importIdeaKeymap(text: string): KeymapImportResult {
  const overrides: KeybindingOverride[] = [];
  const unknown: string[] = [];
  let total = 0;

  for (const match of text.matchAll(/<action\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/action>/g)) {
    const action = match[1]!;
    const body = match[2]!;
    const keys = [...body.matchAll(/<keyboard-shortcut\b[^>]*\bfirst-keystroke="([^"]*)"/g)];
    if (keys.length === 0) continue;
    total += keys.length;

    const ours = IDEA_COMMANDS[action];
    if (!ours) {
      unknown.push(action);
      continue;
    }
    for (const key of keys) {
      const combo = ideaCombo(key[1] ?? '');
      if (combo === null) continue;
      overrides.push({ command: ours, combo });
    }
  }
  return { overrides, total, unknown };
}

/** JSON с комментариями и хвостовыми запятыми — так пишет VS Code. */
function parseJsonC(text: string): unknown {
  // Убираем комментарии только вне строк: `http://` внутри значения иначе
  // разрезало бы строку и разбор упал бы на ровном месте.
  let result = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]!;
    if (inString) {
      result += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      result += ch;
      continue;
    }
    if (ch === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      result += '\n';
      continue;
    }
    if (ch === '/' && text[index + 1] === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index += 1;
      continue;
    }
    result += ch;
  }
  result = result.replace(/,(\s*[\]}])/g, '$1');
  try {
    return JSON.parse(result) as unknown;
  } catch {
    return null;
  }
}

/**
 * Сочетание VS Code — наше. `cmd`/`win` считаем `Ctrl`: Mac-раскладка на
 * Windows иначе не нажмётся вовсе, а похожего у нас нет.
 */
function vscodeCombo(key: string): string | null {
  const parts = key
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  const head = parts.slice(0, -1);
  const main = parts[parts.length - 1]!;
  const out: string[] = [];
  for (const part of head) {
    if (part === 'ctrl' || part === 'cmd' || part === 'win' || part === 'super') out.push('Ctrl');
    else if (part === 'shift') out.push('Shift');
    else if (part === 'alt' || part === 'option') out.push('Alt');
    // Незнакомый модификатор — сочетание не наше: лучше отбросить, чем связать
    // команду с клавишей, которая делает не то.
    else return null;
  }
  const named: Record<string, string> = { esc: 'Escape', return: 'Enter', space: 'Space' };
  const tail = named[main] ?? (main.length === 1 ? main.toUpperCase() : main[0]!.toUpperCase() + main.slice(1));
  out.push(tail);
  return out.join('+');
}

/** Сочетание IDEA — наше: `ctrl alt L`, `shift F6`. */
function ideaCombo(key: string): string | null {
  const parts = key
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  const head = parts.slice(0, -1);
  const main = parts[parts.length - 1]!;
  const out: string[] = [];
  for (const part of head) {
    const lower = part.toLowerCase();
    if (lower === 'ctrl' || lower === 'meta') out.push('Ctrl');
    else if (lower === 'shift') out.push('Shift');
    else if (lower === 'alt') out.push('Alt');
    else return null;
  }
  const named: Record<string, string> = { ESCAPE: 'Escape', ENTER: 'Enter', SPACE: 'Space' };
  const upper = main.toUpperCase();
  const tail = named[upper] ?? (main.length === 1 ? upper : upper[0]! + upper.slice(1).toLowerCase());
  out.push(tail);
  return out.join('+');
}

/**
 * Слить импорт с текущими переопределениями.
 *
 * Уже настроенное человеком НЕ перебиваем: он настраивал это в нашей IDE и
 * помнит именно так. Возвращаем и число пропущенных — чтобы ответ был честным.
 */
export function mergeImportedOverrides(
  current: readonly KeybindingOverride[],
  imported: readonly KeybindingOverride[],
): { overrides: KeybindingOverride[]; skipped: number } {
  const mine = new Set(current.map((entry) => entry.command));
  const added = imported.filter((entry) => !mine.has(entry.command));
  return {
    overrides: [...current, ...added],
    skipped: imported.length - added.length,
  };
}
