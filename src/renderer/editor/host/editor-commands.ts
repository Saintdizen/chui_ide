/**
 * Команды своего редактора: что он умеет и чем это зовётся.
 *
 * У Monaco команды брались у него же (`getSupportedActions`) — 139 пунктов палитры,
 * и почти все они были про его внутренности (свернуть блок, развернуть комментарий,
 * перейти к скобке). Свой редактор так делать не может и не должен: у него есть
 * ровно тот набор действий, который он умеет выполнять, и лучше показать в палитре
 * этот набор целиком, чем прятать за чужими пунктами пустоту.
 *
 * Поэтому здесь СПИСОК КОМАНД — данные, а не код поведения. У каждой команды:
 * идентификатор (наш, с приставкой `editor.`), подпись, англоязычный синоним для
 * поиска (привычка искать по `undo`), необязательное сочетание клавиш и обработчик,
 * которому дают «контекст» — то, чем команда распоряжается. Что именно она делает,
 * решает контекст, а не этот модуль: так список проверяется с подставным контекстом,
 * а хозяин редактора передаёт настоящий.
 *
 * Команды бывают необязательные: переход к определению и поиск ссылок возможны только
 * когда есть языковой сервер, а форматирование — когда у языка есть инструмент.
 * Такие команды объявляют `requires`: без него хозяин их не предлагает, и в палитре
 * не появляется пункт, который ничего не сделает.
 *
 * Модуль чистый: он не знает ни о DOM, ни о контроллере — только о том, что умеет
 * контекст. Поэтому его видно в тестах без окна.
 */

/**
 * Чем распоряжается команда. Синхронные действия есть у любого редактора; необязательные
 * (LSP и форматирование) появляются, только если хозяин их умеет.
 */
export interface EditorCommandContext {
  undo(): void;
  redo(): void;
  selectAll(): void;
  /** Открыть панель поиска или поиска с заменой. */
  openFind(mode: 'find' | 'replace'): void;
  /** Открыть панель перехода к строке. */
  openGoto(): void;
  indent(): void;
  outdent(): void;
  /** Перейти к определению символа под курсором (нужен языковой сервер). */
  goToDefinition?(): void;
  /** Показать ссылки на символ под курсором (нужен языковой сервер). */
  findReferences?(): void;
  /** Переименовать символ под курсором (нужен языковой сервер и ввод имени — дело вызывающего). */
  renameSymbol?(): void;
  /** Перейти к следующей пометке языка (ошибке или предупреждению). */
  nextProblem?(): void;
  /** Перейти к предыдущей пометке языка. */
  previousProblem?(): void;
  /** Отформатировать файл (нужен инструмент языка). */
  formatCode?(): void;
  /** Показать быстрые исправления под курсором (нужен языковой сервер). */
  codeActions?(): void;
  /** Свернуть блок у курсора, развернуть его, свернуть или развернуть всё. */
  fold(): void;
  unfold(): void;
  foldAll(): void;
  unfoldAll(): void;
}

/** Что команда требует от контекста сверх обязательного. */
export type EditorCommandRequirement =
  | 'goToDefinition'
  | 'findReferences'
  | 'renameSymbol'
  | 'formatCode'
  | 'nextProblem'
  | 'previousProblem'
  | 'codeActions';

export interface EditorCommand {
  /** Наш идентификатор: `editor.undo`. Приставка отделяет от команд приложения. */
  readonly id: string;
  /** Подпись в палитре. */
  readonly label: string;
  /** Англоязычное имя, по которому ищут привыкшие к нему: `undo`, `selectAll`. */
  readonly alias: string;
  /** Сочетание клавиш, как его показывает справка (`Ctrl+Z`). */
  readonly keybinding?: string;
  /** Группа в палитре. */
  readonly category?: string;
  /** Необязательная возможность контекста, без которой команда недоступна. */
  readonly requires?: EditorCommandRequirement;
  /** Что делать. Контекст решает, как именно. */
  readonly run: (context: EditorCommandContext) => void;
}

/** Общая категория — по ней команды редактора стоят в палитре одной группой. */
const CATEGORY = 'Редактор';

/**
 * Набор команд редактора. Он и есть ответ на «что умеет свой редактор»: список короткий,
 * но каждая строка работает. Порядок — как в палитре: правки, переход, панели, отступы.
 */
export const EDITOR_COMMANDS: readonly EditorCommand[] = [
  {
    id: 'editor.undo',
    label: 'Отменить',
    alias: 'undo',
    keybinding: 'Ctrl+Z',
    category: CATEGORY,
    run: (context) => context.undo(),
  },
  {
    id: 'editor.redo',
    label: 'Повторить',
    alias: 'redo',
    keybinding: 'Ctrl+Y',
    category: CATEGORY,
    run: (context) => context.redo(),
  },
  {
    id: 'editor.selectAll',
    label: 'Выделить всё',
    alias: 'selectAll',
    keybinding: 'Ctrl+A',
    category: CATEGORY,
    run: (context) => context.selectAll(),
  },
  {
    id: 'editor.find',
    label: 'Найти',
    alias: 'find',
    keybinding: 'Ctrl+F',
    category: CATEGORY,
    run: (context) => context.openFind('find'),
  },
  {
    id: 'editor.replace',
    label: 'Найти и заменить',
    alias: 'replace',
    keybinding: 'Ctrl+H',
    category: CATEGORY,
    run: (context) => context.openFind('replace'),
  },
  {
    id: 'editor.gotoLine',
    label: 'Перейти к строке',
    alias: 'gotoLine',
    keybinding: 'Ctrl+G',
    category: CATEGORY,
    run: (context) => context.openGoto(),
  },
  {
    id: 'editor.indent',
    label: 'Увеличить отступ',
    alias: 'indent',
    keybinding: 'Tab',
    category: CATEGORY,
    run: (context) => context.indent(),
  },
  {
    id: 'editor.outdent',
    label: 'Уменьшить отступ',
    alias: 'outdent',
    keybinding: 'Shift+Tab',
    category: CATEGORY,
    run: (context) => context.outdent(),
  },
  {
    id: 'editor.goToDefinition',
    label: 'Перейти к определению',
    alias: 'goToDefinition',
    keybinding: 'F12',
    category: 'Навигация',
    requires: 'goToDefinition',
    run: (context) => context.goToDefinition?.(),
  },
  {
    id: 'editor.references',
    label: 'Найти все ссылки',
    alias: 'findAllReferences',
    keybinding: 'Shift+F12',
    category: 'Навигация',
    requires: 'findReferences',
    run: (context) => context.findReferences?.(),
  },
  {
    id: 'editor.renameSymbol',
    label: 'Переименовать символ',
    alias: 'renameSymbol',
    keybinding: 'F2',
    category: 'Навигация',
    requires: 'renameSymbol',
    run: (context) => context.renameSymbol?.(),
  },
  {
    id: 'editor.format',
    label: 'Форматировать файл',
    alias: 'formatDocument',
    keybinding: 'Shift+Alt+F',
    category: CATEGORY,
    requires: 'formatCode',
    run: (context) => context.formatCode?.(),
  },
  {
    id: 'editor.fold',
    label: 'Свернуть блок',
    alias: 'fold',
    keybinding: 'Ctrl+Shift+[',
    category: CATEGORY,
    run: (context) => context.fold(),
  },
  {
    id: 'editor.unfold',
    label: 'Развернуть блок',
    alias: 'unfold',
    keybinding: 'Ctrl+Shift+]',
    category: CATEGORY,
    run: (context) => context.unfold(),
  },
  {
    id: 'editor.foldAll',
    label: 'Свернуть всё',
    alias: 'foldAll',
    category: CATEGORY,
    run: (context) => context.foldAll(),
  },
  {
    id: 'editor.unfoldAll',
    label: 'Развернуть всё',
    alias: 'unfoldAll',
    category: CATEGORY,
    run: (context) => context.unfoldAll(),
  },
  {
    id: 'editor.codeActions',
    label: 'Быстрые исправления',
    alias: 'quickFix',
    keybinding: 'Ctrl+.',
    category: CATEGORY,
    requires: 'codeActions',
    run: (context) => context.codeActions?.(),
  },
  {
    id: 'editor.nextProblem',
    label: 'Следующая проблема',
    alias: 'goToNextProblem',
    keybinding: 'F8',
    category: 'Навигация',
    requires: 'nextProblem',
    run: (context) => context.nextProblem?.(),
  },
  {
    id: 'editor.previousProblem',
    label: 'Предыдущая проблема',
    alias: 'goToPreviousProblem',
    keybinding: 'Shift+F8',
    category: 'Навигация',
    requires: 'previousProblem',
    run: (context) => context.previousProblem?.(),
  },
];

/**
 * Команды, доступные с этим контекстом: необязательные отсеиваются, если контекст их
 * не умеет. Так в палитру не попадает пункт, который молча ничего не сделает, — в этом
 * и был главный изъян переноса чужих действий.
 */
export function availableCommands(context: EditorCommandContext): EditorCommand[] {
  return EDITOR_COMMANDS.filter((command) => !command.requires || context[command.requires] !== undefined);
}

/** Команда по идентификатору. `undefined` — такой команды у редактора нет. */
export function findEditorCommand(id: string): EditorCommand | undefined {
  return EDITOR_COMMANDS.find((command) => command.id === id);
}

/** Сочетание клавиш команды — для справки и подсказок. `null` — сочетания нет. */
export function keybindingForCommand(id: string): string | null {
  return findEditorCommand(id)?.keybinding ?? null;
}
