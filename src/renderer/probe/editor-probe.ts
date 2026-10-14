/**
 * Точка входа для пробы своего редактора (`npm run probe:editor`).
 *
 * Модуль не входит в приложение: он поднимает редактор на отдельной странице, чтобы
 * пробе было что смотреть. Собирается отдельно (`scripts/own-editor-probe.cjs`),
 * результат грузится в окно Electron — так видно верстку в настоящем Chromium.
 *
 * На `window` кладётся `probe` с полями буфера и представления: проба дёргает их
 * через `executeJavaScript`, ставит выделение, прокручивает и снимает снимки.
 */

import { TextBuffer } from '../editor/core/text-buffer';
import { EditorController } from '../editor/input/editor-controller';
import { EditorInputBinding } from '../editor/input/editor-input';
import { EditorView } from '../editor/view/editor-view';
import { CompletionAssistant } from '../editor/complete/assistant';
import { FindWidget } from '../editor/widgets/find-widget';
import { GotoLineWidget } from '../editor/widgets/goto-widget';
import { HoverWidget } from '../editor/widgets/hover-widget';
import { SuggestWidget } from '../editor/widgets/suggest-widget';
import { DEFAULT_SNIPPETS } from '../../shared/snippets';
import { DocumentStore } from '../core/document-store';
import type { TextDocument } from '../core/document';
import { EditorHost } from '../editor/host/editor-host';
import { EditorWorkspace } from '../editor/host/editor-workspace';
import { DocumentRegistry } from '../editor/host/document-registry';
import { SpellCheck } from '../core/spellcheck';
import { FileDecorations } from '../editor/view/decorations';
import { OwnDiffEditor } from '../editor/host/diff-editor';
import { createProblemPanel } from '../ui/problem-panel';
import { createMarkdownRenderer } from '../ui/chat-markdown';
import type { DiagnosticItem } from '../../shared/api';
import type { SymbolLocation } from '../../shared/lsp-locations';
import { indentFoldRanges, mergeFoldRanges } from '../../shared/fold-ranges';
import { semanticFoldRanges } from '../editor/highlight/folds';

/**
 * Документ для пробы. Собран так, чтобы задеть всё, что есть в раскладке:
 * простые строки, латиница и кириллица, табуляция, широкие знаки, эмодзи и одна
 * очень длинная строка — из-за неё появляется горизонтальная прокрутка. Ниже —
 * много строк-заполнителей: на них видно, что виртуализация работает (в DOM
 * попадают только видимые строки, а не все).
 */
function sampleDocument(): string {
  const head = [
    '// проба своего редактора: раскладка строки, каретка, выделение, прокрутка',
    '',
    'const ascii = "plain latin text with digits 0123456789";',
    'const кириллица = "строка на кириллице: смещения в UTF-16";',
    '\tтабуляция\tведёт\tк\tкратному\tстолбцу',
    'const wide = "日本語のテキスト" + "한국어";',
    'const emoji = "😀 👍🏽 👨‍👩‍👧";',
    '// управляющие конструкции, вызовы и типы — тоже. TODO: дописать проверку',
    'if (value > 1) { handle(value); }',
    'const typed: string = "x";',
    `const long = "${'длинная-строка-'.repeat(24)}";`,
    '',
    '// ниже — заполнитель, чтобы строк стало много',
  ];
  const filler = Array.from({ length: 2000 }, (_, index) => `const line${index} = ${index};`);
  return [...head, ...filler].join('\n');
}

// Ошибки страницы собираем со стеком: в отчёт пробы попадает только текст сообщения,
// а по нему не видно, откуда оно. Теперь проба сама говорит, где искать.
declare global {
  interface Window {
    __errors: string[];
  }
}
window.__errors = [];
window.addEventListener('error', (event) => {
  const stack = event.error instanceof Error ? event.error.stack : null;
  window.__errors.push(`${event.message}\n${stack ?? '(без стека)'}`);
});
window.addEventListener('unhandledrejection', (event) => {
  window.__errors.push(`отклонён промис: ${String(event.reason)}`);
});

const root = document.getElementById('probe-root');
if (!root) throw new Error('не найден #probe-root');

// Плавная прокрутка проверяется на своём полотне с ДЛИННЫМ документом: на коротком
// файле прокручивать нечего, и признак «поехало по кадрам» ничего не показал бы.
const scrollRoot = document.createElement('div');
scrollRoot.id = 'probe-scroll';
scrollRoot.style.cssText = 'position: absolute; left: -4000px; top: 0; width: 700px; height: 400px';
document.body.append(scrollRoot);
const scrollBuffer = new TextBuffer(
  Array.from({ length: 2000 }, (_, index) => `const line${index} = ${index};`).join('\n'),
);
const scrollView = new EditorView(scrollRoot, scrollBuffer, { language: 'typescript', scheme: 'dark' });
// Ввод на этом же полотне: макросы проверяются живыми клавишами, а текст тут
// предсказуемый (2000 одинаковых строк) — видно, что макрос повторил то же действие.
const scrollController = new EditorController(scrollBuffer);
const scrollInput = new EditorInputBinding(scrollView, scrollController, {});

const buffer = new TextBuffer(sampleDocument());
// Язык и схема заданы — значит, строки собираются из токенов с цветами темы.
const view = new EditorView(root, buffer, { language: 'typescript', scheme: 'dark' });
// Контроллер держит текст, курсор и историю; ввод — связка DOM с ним. Так же, как
// будет в приложении: представление, контроллер и ввод — три разных слоя.
const controller = new EditorController(buffer);
const find = new FindWidget(view, controller, buffer);
const goto = new GotoLineWidget(view, controller, buffer);
// Подсказки и наведение: попапы, которые видят изменения ввода и могут забрать клавишу.
const suggest = new SuggestWidget(root);
// Сниппеты — набор по умолчанию: в приложении к нему добавятся свои из настроек.
const assistant = new CompletionAssistant(view, controller, buffer, suggest, {
  language: 'typescript',
  snippets: () => DEFAULT_SNIPPETS,
  // Подставной языковой сервер: одна подсказка с авто-импортом — так проба проверяет,
  // что дополнительные правки (строка import) применяются вместе со вставкой.
  lsp: async (prefix) =>
    prefix === 'Path'
      ? [
          {
            label: 'Path',
            kind: 'external' as const,
            detail: 'класс',
            insert: 'Path',
            additionalEdits: [
              { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1, newText: 'from pathlib import Path\n' },
            ],
          },
        ]
      : [],
});
// Наведение с двумя источниками ПО ПРИОРИТЕТУ: отладочная подсказка (значение из
// остановленного кадра) идёт раньше языковой. Переключатель `debugHoverControl.on`
// позволяет пробе увидеть оба случая: с отладчиком и без него.
const debugHoverControl = { on: false };
// Пометки, которые проба кладёт в наведение: карточка обязана показать их ТЕКСТ, а не
// только волну под словом (см. `problems` в `hover-widget.ts`).
const hoverProblems: {
  line: number;
  column: number;
  endColumn: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  source?: string;
}[] = [];
const hover = new HoverWidget(view, buffer, {
  problems: (offset) => {
    const position = buffer.positionAt(offset);
    return hoverProblems.filter(
      (item) =>
        item.line === position.line &&
        position.column >= item.column &&
        position.column <= Math.max(item.endColumn, item.column + 1),
    );
  },
  sources: [
    async () => (debugHoverControl.on ? { title: 'отладчик', text: '`x` = 42 — `int`' } : null),
    async (offset) => {
      const text = buffer.lineText(buffer.lineAt(offset));
      if (!text.includes('EMPTY')) return { title: 'подсказка от сервера', text: 'тип: string\nдокументация: из LSP' };
      return null;
    },
  ],
});
// Ctrl+F, Ctrl+H и Ctrl+G ввод выполняет сам, а показывает панели — вызывающий: так
// один и тот же ввод годится и для приложения, и для пробы.
const input = new EditorInputBinding(view, controller, {
  onCommand: (command) => {
    if (command === 'gotoLine') goto.show();
    else find.show(command === 'replace' ? 'replace' : 'find');
  },
  // Порядок перехватчиков = приоритет: подсказки забирают клавишу раньше наведения.
  interceptors: [assistant],
});
// После закрытия панели фокус возвращается в текст: работа продолжается там.
find.onClose = () => input.focus();
goto.onClose = () => input.focus();
input.focus();

declare global {
  interface Window {
    probeScroll: {
      view: EditorView;
      buffer: TextBuffer;
      controller: EditorController;
      input: EditorInputBinding;
    };
    probe: {
      view: EditorView;
      buffer: TextBuffer;
      controller: EditorController;
      input: EditorInputBinding;
      find: FindWidget;
      goto: GotoLineWidget;
      suggest: SuggestWidget;
      assistant: CompletionAssistant;
      hover: HoverWidget;
      hoverProblems: {
        line: number;
        column: number;
        endColumn: number;
        severity: 'error' | 'warning' | 'info';
        message: string;
        source?: string;
      }[];
      debugHoverControl: { on: boolean };
      decorations: FileDecorations;
      decorationClicks: { glyph: number[]; glyphMenu: number[]; strip: number[] };
    };
  }
}

// Украшения: набор для пробы и счётчики кликов. Проба ставит их извне (через
// `window.probe.decorations`), а сюда приходят нажатия по полю значков и полосе.
const decorations = new FileDecorations();
view.setDecorations(decorations);
const decorationClicks: { glyph: number[]; glyphMenu: number[]; strip: number[] } = {
  glyph: [],
  glyphMenu: [],
  strip: [],
};
view.onGlyphClick = (line) => decorationClicks.glyph.push(line);
view.onGlyphContextMenu = (line) => decorationClicks.glyphMenu.push(line);
view.onStripClick = (line) => decorationClicks.strip.push(line);

window.probeScroll = { view: scrollView, buffer: scrollBuffer, controller: scrollController, input: scrollInput };

window.probe = {
  view,
  buffer,
  controller,
  input,
  find,
  goto,
  suggest,
  assistant,
  hover,
  hoverProblems,
  debugHoverControl,
  decorations,
  decorationClicks,
};

// Хозяин редактора проверяется на отдельном, скрытом полотне. Его дело — открытие,
// правки и курсоры: это про текст, а не про пиксели, и основной пробе оно не мешает.
const hostRoot = document.createElement('div');
hostRoot.id = 'probe-host';
hostRoot.style.cssText = 'position: absolute; left: -4000px; top: 0; width: 700px; height: 480px';
document.body.append(hostRoot);

const store = new DocumentStore();
const registry = new DocumentRegistry(store);
/** Куда пробе записываются вызовы быстрых исправлений (Ctrl+.). */
const codeActionCalls: Array<{ path: string; position: { line: number; column: number } }> = [];
const host = new EditorHost(hostRoot, registry, {
  scheme: 'dark',
  // Подсказка о параметрах вызова: подставной источник — пробе важно не «откуда сигнатура»,
  // а что карточка показывается, подсвечивает активный довод и листает перегрузки.
  signatureFromLanguage: async () => ({
    signatures: [
      {
        label: 'f(a, b)',
        documentation: 'проба: подпись вызова',
        parameters: [
          { text: 'a', start: 2, end: 3 },
          { text: 'b', start: 5, end: 6 },
        ],
      },
      { label: 'f(a, b, c)', documentation: null, parameters: [] },
    ],
    activeSignature: 0,
    activeParameter: 1,
  }),
  // Быстрые исправления: пробе важно, что Ctrl+. доходит до приложения (в приложении
  // там запрос к серверу и список) — запоминаем, с какой позицией его позвали.
  codeActions: (path, position) => codeActionCalls.push({ path, position }),
});
const docA = store.open('/probe/a.ts', 'const a = 1;\nconst b = 2;\n', { languageId: 'typescript' });
const docB = store.open('/probe/b.py', 'def f():\n    return 1\n', { languageId: 'python' });
host.open(docA);

declare global {
  interface Window {
    probeHost: {
      host: EditorHost;
      store: DocumentStore;
      registry: DocumentRegistry;
      docA: TextDocument;
      docB: TextDocument;
      codeActions: Array<{ path: string; position: { line: number; column: number } }>;
    };
  }
}

window.probeHost = { host, store, registry, docA, docB, codeActions: codeActionCalls };

// Рабочее место (одна или две панели) — на своём скрытом полотне. Оно проверяется
// отдельно от хозяина: тут важны разделение, активная панель и общий буфер.
const workspaceRoot = document.createElement('div');
workspaceRoot.id = 'probe-workspace';
workspaceRoot.style.cssText = 'position: absolute; left: -4000px; top: 0; width: 700px; height: 480px';
document.body.append(workspaceRoot);

const workspaceStore = new DocumentStore();
const workspaceRegistry = new DocumentRegistry(workspaceStore);
const workspace = new EditorWorkspace(workspaceRoot, workspaceRegistry, { scheme: 'dark' });
const leftDoc = workspaceStore.open('/probe/left.ts', 'const left = 1;\nconst two = 2;\n', {
  languageId: 'typescript',
});
const rightDoc = workspaceStore.open('/probe/right.py', 'def right():\n    return 2\n', { languageId: 'python' });
workspace.open(leftDoc);

declare global {
  interface Window {
    probeWorkspace: {
      workspace: EditorWorkspace;
      store: DocumentStore;
      leftDoc: TextDocument;
      rightDoc: TextDocument;
    };
  }
}

window.probeWorkspace = { workspace, store: workspaceStore, leftDoc, rightDoc };

// Сравнение версий — на своём скрытом полотне: проверяются ряды выравнивания,
// оба режима (рядом / одним столбцом) и кнопки у блоков.
const diffRoot = document.createElement('div');
diffRoot.id = 'probe-diff';
diffRoot.style.cssText = 'position: absolute; left: -4000px; top: 0; width: 700px; height: 360px';
document.body.append(diffRoot);
const diff = new OwnDiffEditor(diffRoot, { scheme: 'dark' });

declare global {
  interface Window {
    probeDiff: { diff: OwnDiffEditor; element: HTMLElement };
  }
}

window.probeDiff = { diff, element: diffRoot };

// Переход к определению и ссылки: у рабочего места есть источник мест (подставной
// «языковой сервер»). Что вернёт сервер, задаёт проба через `answers`; переходы и
// сообщения записываем — по ним видно, что именно случилось: прыжок, список или весть.
const symbolsRoot = document.createElement('div');
symbolsRoot.id = 'probe-symbols';
symbolsRoot.style.cssText = 'position: absolute; left: -4000px; top: 0; width: 700px; height: 480px';
document.body.append(symbolsRoot);

const symbolsStore = new DocumentStore();
const symbolsRegistry = new DocumentRegistry(symbolsStore);
const revealedSpots: Array<{ path: string; line: number; column: number }> = [];
const symbolNotices: string[] = [];
const symbolAnswers: { definition: SymbolLocation[]; references: SymbolLocation[] } = {
  definition: [],
  references: [],
};
/** Запросы дотягивания подсказок: по ним видно, спрашивали ли описание (см. `resolveCompletionItem`). */
const resolvedCompletions: unknown[] = [];
/** Клики по ссылкам в коде: по ним видно, дошёл ли клик до приложения. */
const linkOpens: Array<{ target: string; path: string }> = [];
/** Вхождения слова «div» — подставной сервер отдаёт их как связанные участки (парные теги). */
function linkedRangesIn(text: string): { line: number; startColumn: number; endColumn: number }[] {
  const word = 'div';
  const out: { line: number; startColumn: number; endColumn: number }[] = [];
  text.split('\n').forEach((line, index) => {
    for (let from = 0; ; ) {
      const at = line.indexOf(word, from);
      if (at < 0) break;
      out.push({ line: index + 1, startColumn: at + 1, endColumn: at + 1 + word.length });
      from = at + word.length;
    }
  });
  return out.length >= 2 ? out : [];
}

const symbolsWorkspace = new EditorWorkspace(symbolsRoot, symbolsRegistry, {
  scheme: 'dark',
  symbols: {
    definition: async () => symbolAnswers.definition,
    references: async () => symbolAnswers.references,
  },
  // Подсказки сервера: подставной источник отдаёт готовые элементы — проверяем, что
  // они подмешиваются в список впереди своих слов и вставляются по Enter.
  completionFromLanguage: async () => [
    { label: 'value', kind: 'external' as const, detail: 'переменная', insert: 'value', resolve: { label: 'value' } },
    {
      label: 'valuableThing',
      kind: 'external' as const,
      detail: 'функция',
      insert: 'valuableThing()',
      resolve: { label: 'valuableThing' },
    },
  ],
  // Дотягивание подсказки: описание приходит отдельным запросом — проверяем, что
  // строка списка его дописывает (проверка `own-editor-probe.cjs`).
  resolveCompletionItem: async (_path, item) => {
    resolvedCompletions.push(item);
    return { documentation: 'Документация: valuableThing делает важное.' };
  },
  // Ссылки в коде: подставной источник даёт одну ссылку — проверяем показ и клик.
  documentLinks: async () => [{ line: 1, startColumn: 1, endColumn: 4, target: 'https://example.com/' }],
  openLink: (target, path) => linkOpens.push({ target, path }),
  revealLocation: (path, line, column) => revealedSpots.push({ path, line, column }),
  relativePath: (path) => path.replace('/probe/', ''),
  onNotice: (text) => symbolNotices.push(text),
});
const symbolsDoc = symbolsStore.open('/probe/sym.ts', 'const value = 1;\nuse(value);\n', { languageId: 'typescript' });
symbolsWorkspace.open(symbolsDoc);
// F1 открывает палитру: у рабочего места это свой обработчик (у Monaco было его действие),
// а отладочная подсказка спрашивает значение слова — оба шва проверяем отсюда.
const paletteOpens: string[] = [];
symbolsWorkspace.openPaletteOnF1(() => paletteOpens.push('open'));
symbolsWorkspace.setDebugHover(async () => ({ value: '42', type: 'int' }));

declare global {
  interface Window {
    probeSymbols: {
      workspace: EditorWorkspace;
      store: DocumentStore;
      doc: TextDocument;
      answers: { definition: SymbolLocation[]; references: SymbolLocation[] };
      revealed: Array<{ path: string; line: number; column: number }>;
      notices: string[];
      paletteOpens: string[];
      resolvedCompletions: unknown[];
      linkOpens: Array<{ target: string; path: string }>;
    };
  }
}

// Обёртка выделения: шов `surroundWith` показывает список вариантов (в приложении — модалка),
// а применяет выбранную пару редактор. Здесь шов подставной: хотят проверить, что сочетание
// клавиш доходит до вызывающего и что обёртка ложится вокруг выделения.
const surroundRoot = document.createElement('div');
surroundRoot.id = 'probe-surround';
surroundRoot.style.cssText = 'position: absolute; left: -4000px; top: 0; width: 700px; height: 480px';
document.body.append(surroundRoot);

const surroundStore = new DocumentStore();
const surroundRegistry = new DocumentRegistry(surroundStore);
const surroundRequests: string[] = [];
const surroundWorkspace = new EditorWorkspace(surroundRoot, surroundRegistry, {
  scheme: 'dark',
  surroundWith: () => surroundRequests.push(surroundWorkspace.activeLanguage()),
});
const surroundDoc = surroundStore.open('/probe/surround.ts', 'const total = a + b;\n', { languageId: 'typescript' });
surroundWorkspace.open(surroundDoc);

declare global {
  interface Window {
    probeSurround: {
      workspace: EditorWorkspace;
      store: DocumentStore;
      doc: TextDocument;
      requests: string[];
    };
  }
}

window.probeSurround = {
  workspace: surroundWorkspace,
  store: surroundStore,
  doc: surroundDoc,
  requests: surroundRequests,
};

// Свёртка без языкового сервера: диапазоны считает рабочее место само — по грамматике
// (скобки) и по отступам, как в приложении (см. `foldRanges` в `app.ts`). Файл собран
// так, что по ОТСТУПАМ блок не виден (все строки с нулевым отступом), а по СКОБКАМ —
// виден: так проверка отличает грамматическую свёртку от отступной.
const foldsRoot = document.createElement('div');
foldsRoot.id = 'probe-folds';
foldsRoot.style.cssText = 'position: absolute; left: -4000px; top: 0; width: 700px; height: 480px';
document.body.append(foldsRoot);

const foldsStore = new DocumentStore();
const foldsRegistry = new DocumentRegistry(foldsStore);
const foldsWorkspace = new EditorWorkspace(foldsRoot, foldsRegistry, {
  scheme: 'dark',
  foldRanges: async (_path, text) =>
    mergeFoldRanges([...semanticFoldRanges(text, 'typescript'), ...indentFoldRanges(text, 4)]),
});
const foldsDoc = foldsStore.open(
  '/probe/folds.ts',
  ['function main() {', "console.log('hi');", 'return 0;', '}', '// хвост файла'].join('\n'),
  { languageId: 'typescript' },
);
foldsWorkspace.open(foldsDoc);

declare global {
  interface Window {
    probeFolds: { workspace: EditorWorkspace; store: DocumentStore; doc: TextDocument };
  }
}

window.probeFolds = { workspace: foldsWorkspace, store: foldsStore, doc: foldsDoc };

// Форматирование участка: швы `formatRange` (сервер правит выделенный кусок) и
// `formatOnPaste` (правка вставленного). Записываем запросы — по ним видно, что
// команда и вставка доходят до приложения с 1-based диапазоном.
const formatRoot = document.createElement('div');
formatRoot.id = 'probe-format';
formatRoot.style.cssText = 'position: absolute; left: -4000px; top: 0; width: 700px; height: 480px';
document.body.append(formatRoot);

const formatStore = new DocumentStore();
const formatRegistry = new DocumentRegistry(formatStore);
const formatRequests: Array<{
  path: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}> = [];
const formatControl = { onPaste: true };
const formatWorkspace = new EditorWorkspace(formatRoot, formatRegistry, {
  scheme: 'dark',
  formatRange: (path, range) => formatRequests.push({ path, ...range }),
  formatOnPaste: () => formatControl.onPaste,
});
const formatDoc = formatStore.open('/probe/format.ts', 'const value = 1;\nconst other = 2;\n', {
  languageId: 'typescript',
});
formatWorkspace.open(formatDoc);

declare global {
  interface Window {
    probeFormat: {
      workspace: EditorWorkspace;
      store: DocumentStore;
      doc: TextDocument;
      requests: Array<{ path: string; startLine: number; startColumn: number; endLine: number; endColumn: number }>;
      control: { onPaste: boolean };
    };
  }
}

window.probeFormat = {
  workspace: formatWorkspace,
  store: formatStore,
  doc: formatDoc,
  requests: formatRequests,
  control: formatControl,
};

// Заглянуть в определение: подставной сервер отдаёт ДВА места в другом файле, а текст
// того файла — шов чтения (`readText`). Проверяем показ копии, счётчик мест, ход по
// местам и «Открыть» (переход насовсем). Отдельный редактор — чтобы проверка не
// зависела от правок соседних проб.
const peekRoot = document.createElement('div');
peekRoot.id = 'probe-peek';
peekRoot.style.cssText = 'position: absolute; left: -4000px; top: 0; width: 700px; height: 480px';
document.body.append(peekRoot);

const peekStore = new DocumentStore();
const peekRegistry = new DocumentRegistry(peekStore);
const peekRevealed: Array<{ path: string; line: number; column: number }> = [];
const peekNotices: string[] = [];
/** Тексты «других файлов»: их отдаёт шов чтения (в приложении — диск). */
const peekFiles: Record<string, string> = {};
const peekAnswers: { definition: SymbolLocation[] } = { definition: [] };
const peekReads: string[] = [];

const peekWorkspace = new EditorWorkspace(peekRoot, peekRegistry, {
  scheme: 'dark',
  symbols: {
    definition: async () => peekAnswers.definition,
    references: async () => [],
  },
  readText: async (path) => {
    peekReads.push(path);
    return peekFiles[path] ?? null;
  },
  relativePath: (path) => path.replace('/probe/', ''),
  revealLocation: (path, line, column) => peekRevealed.push({ path, line, column }),
  onNotice: (text) => peekNotices.push(text),
});
const peekDoc = peekStore.open('/probe/peek-main.ts', 'use(value);\n', { languageId: 'typescript' });
peekWorkspace.open(peekDoc);

declare global {
  interface Window {
    probePeek: {
      workspace: EditorWorkspace;
      store: DocumentStore;
      doc: TextDocument;
      answers: { definition: SymbolLocation[] };
      files: Record<string, string>;
      reads: string[];
      revealed: Array<{ path: string; line: number; column: number }>;
      notices: string[];
    };
  }
}

window.probePeek = {
  workspace: peekWorkspace,
  store: peekStore,
  doc: peekDoc,
  answers: peekAnswers,
  files: peekFiles,
  reads: peekReads,
  revealed: peekRevealed,
  notices: peekNotices,
};

window.probeSymbols = {
  workspace: symbolsWorkspace,
  store: symbolsStore,
  doc: symbolsDoc,
  answers: symbolAnswers,
  revealed: revealedSpots,
  notices: symbolNotices,
  paletteOpens,
  resolvedCompletions,
  linkOpens,
};

// Inline-подсказка «допиши за меня»: подставной «модель» возвращает готовый текст, а
// рабочее место показывает его призрачным текстом и принимает по Tab. Запросы и слово
// включения записываем — по ним видно, спрашивали ли модель и когда замолчали.
const inlineRoot = document.createElement('div');
inlineRoot.id = 'probe-inline';
inlineRoot.style.cssText = 'position: absolute; left: -4000px; top: 0; width: 700px; height: 480px';
document.body.append(inlineRoot);

const inlineStore = new DocumentStore();
const inlineRegistry = new DocumentRegistry(inlineStore);
const inlineCalls: Array<{ path: string; language: string; prefix: string; suffix: string }> = [];
const inlineControl = { enabled: true, answer: ' + 42' };
const inlineWorkspace = new EditorWorkspace(inlineRoot, inlineRegistry, {
  scheme: 'dark',
  inlineCompletion: {
    enabled: () => inlineControl.enabled,
    debounceMs: () => 40,
    complete: async (request) => {
      inlineCalls.push(request);
      return inlineControl.answer;
    },
  },
});
const inlineDoc = inlineStore.open('/probe/inline.ts', 'const n = 1;\n', { languageId: 'typescript' });
inlineWorkspace.open(inlineDoc);

declare global {
  interface Window {
    probeInline: {
      workspace: EditorWorkspace;
      store: DocumentStore;
      doc: TextDocument;
      calls: Array<{ path: string; language: string; prefix: string; suffix: string }>;
      control: { enabled: boolean; answer: string };
    };
  }
}

window.probeInline = {
  workspace: inlineWorkspace,
  store: inlineStore,
  doc: inlineDoc,
  calls: inlineCalls,
  control: inlineControl,
};

// Связанные участки (linkedEditing): отдельный редактор с парными «тегами», чтобы проверка
// не зависела от правок других проб. Подставной сервер отдаёт вхождения слова «value» как
// связанные; проверяем подсветку и то, что правка в одном повторяется в остальных.
const linkedRoot = document.createElement('div');
linkedRoot.id = 'probe-linked';
linkedRoot.style.cssText = 'position: absolute; left: -4000px; top: 0; width: 700px; height: 480px';
document.body.append(linkedRoot);

const linkedStore = new DocumentStore();
const linkedRegistry = new DocumentRegistry(linkedStore);
const linkedWorkspace = new EditorWorkspace(linkedRoot, linkedRegistry, {
  scheme: 'dark',
  linkedEditing: async () => linkedRangesIn(linkedDoc.value),
});
const linkedDoc = linkedStore.open('/probe/linked.html', '<div></div>\n', { languageId: 'html' });
linkedWorkspace.open(linkedDoc);

declare global {
  interface Window {
    probeLinked: { workspace: EditorWorkspace; store: DocumentStore; doc: TextDocument };
  }
}

window.probeLinked = { workspace: linkedWorkspace, store: linkedStore, doc: linkedDoc };

// Emmet: отдельный редактор с языком разметки. Проверяем, что Tab раскрывает сокращение
// перед кареткой в настоящем окне (см. `emmetCheck` в пробе).
const emmetRoot = document.createElement('div');
emmetRoot.id = 'probe-emmet';
emmetRoot.style.cssText = 'position: absolute; left: -4000px; top: 0; width: 700px; height: 480px';
document.body.append(emmetRoot);

const emmetStore = new DocumentStore();
const emmetRegistry = new DocumentRegistry(emmetStore);
const emmetWorkspace = new EditorWorkspace(emmetRoot, emmetRegistry, {
  scheme: 'dark',
  emmetEnabled: () => true,
});
const emmetDoc = emmetStore.open('/probe/index.html', '', { languageId: 'html' });
emmetWorkspace.open(emmetDoc);

declare global {
  interface Window {
    probeEmmet: { workspace: EditorWorkspace; store: DocumentStore; doc: TextDocument };
  }
}

window.probeEmmet = { workspace: emmetWorkspace, store: emmetStore, doc: emmetDoc };

// Проверка орфографии: слово не из словаря подчёркивается в комментарии зелёной волной.
const spellRoot = document.createElement('div');
spellRoot.id = 'probe-spell';
spellRoot.style.cssText = 'position: absolute; left: -4000px; top: 0; width: 700px; height: 480px';
document.body.append(spellRoot);

const spellStore = new DocumentStore();
const spellRegistry = new DocumentRegistry(spellStore);
const spellLexicon = new SpellCheck();
spellLexicon.setDictionary(['const', 'value', 'world', 'the', 'is']);
const spellWorkspace = new EditorWorkspace(spellRoot, spellRegistry, {
  scheme: 'dark',
  spellcheck: spellLexicon,
  spellcheckEnabled: () => true,
});
const spellDoc = spellStore.open('/probe/spell.ts', '// helo world\nconst value = 1; // mispel\n', {
  languageId: 'typescript',
});
spellWorkspace.open(spellDoc);

declare global {
  interface Window {
    probeSpell: {
      workspace: EditorWorkspace;
      store: DocumentStore;
      doc: TextDocument;
      lexicon: SpellCheck;
    };
  }
}

window.probeSpell = { workspace: spellWorkspace, store: spellStore, doc: spellDoc, lexicon: spellLexicon };

// Переход по пометкам (F8): пометки кладём в рабочее место через тот же шов, что и LSP
// (`setExternalMarkers`), а переходы записываем — по ним видно, куда повела команда.
const problemsRoot = document.createElement('div');
problemsRoot.id = 'probe-problems';
problemsRoot.style.cssText = 'position: absolute; left: -4000px; top: 0; width: 700px; height: 480px';
document.body.append(problemsRoot);

const problemsStore = new DocumentStore();
const problemsRegistry = new DocumentRegistry(problemsStore);
const problemSpots: Array<{ path: string; line: number; column: number }> = [];
const problemNotices: string[] = [];
const problemsWorkspace = new EditorWorkspace(problemsRoot, problemsRegistry, {
  scheme: 'dark',
  // Переход: записываем место и — как это делает приложение — ставим туда курсор,
  // иначе «следующая пометка» всегда считалась бы от одной и той же строки.
  revealLocation: (path, line, column) => {
    problemSpots.push({ path, line, column });
    problemsWorkspace.reveal(path, line, column);
  },
  onNotice: (text) => problemNotices.push(text),
});
const problemsDoc = problemsStore.open('/probe/problems.ts', 'const a = 1;\nconst b = 2;\nconst c = 3;\n', {
  languageId: 'typescript',
});
problemsWorkspace.open(problemsDoc);

// Три пометки: две в открытом файле, одна в другом — переход должен открыть и её.
problemsWorkspace.setExternalMarkers(problemsDoc.path, 'lsp', [
  { line: 2, column: 7, endLine: 2, endColumn: 8, severity: 'error', message: 'ошибка', source: 'ts' },
  { line: 3, column: 7, endLine: 3, endColumn: 8, severity: 'warning', message: 'предупреждение', source: 'ts' },
]);
problemsWorkspace.setExternalMarkers('/probe/other.ts', 'lsp', [
  { line: 1, column: 1, endLine: 1, endColumn: 2, severity: 'info', message: 'подсказка', source: 'ts' },
]);

declare global {
  interface Window {
    probeProblems: {
      workspace: EditorWorkspace;
      store: DocumentStore;
      doc: TextDocument;
      spots: Array<{ path: string; line: number; column: number }>;
      notices: string[];
    };
  }
}

window.probeProblems = {
  workspace: problemsWorkspace,
  store: problemsStore,
  doc: problemsDoc,
  spots: problemSpots,
  notices: problemNotices,
};

// Панель «Проблемы» — на своём скрытом узле: проверяем строки, фильтр и переход по клику.
// Пометки панель берёт у вызывающего (в приложении — у рабочего места), а переход —
// через шов: здесь это запись места, там — открытие файла и курсор.
const problemPanelRoot = document.createElement('div');
problemPanelRoot.id = 'probe-problem-panel';
problemPanelRoot.style.cssText = 'position: absolute; left: -4000px; top: 0; width: 700px; height: 480px';
document.body.append(problemPanelRoot);

let panelMarkers: DiagnosticItem[] = [];
const panelClicks: Array<{ path: string; line: number; column: number }> = [];
const problemsPanel = createProblemPanel({
  markers: () => panelMarkers,
  reveal: (path, line, column) => panelClicks.push({ path, line, column }),
  // Подпись — как в приложении: короткий путь, а не полный.
  label: (path) => path.replace(/^\/probe\//, ''),
});
problemPanelRoot.append(problemsPanel.element);

declare global {
  interface Window {
    probeProblemPanel: {
      panel: ReturnType<typeof createProblemPanel>;
      clicks: Array<{ path: string; line: number; column: number }>;
      setMarkers: (markers: DiagnosticItem[]) => void;
    };
  }
}

window.probeProblemPanel = {
  panel: problemsPanel,
  clicks: panelClicks,
  setMarkers: (markers) => {
    panelMarkers = markers;
    problemsPanel.refresh();
  },
};

// Выделение по структуре (selectionRange): подставной сервер отдаёт
// фиксированную цепочку участков вокруг имени «a» — само имя, выражение «a + b» и всю строку.
// Проверяем, что «шире»/«уже» ходят по цепочке на шаг.
const selectionRoot = document.createElement('div');
selectionRoot.id = 'probe-selection';
selectionRoot.style.cssText = 'position: absolute; left: -4000px; top: 0; width: 700px; height: 480px';
document.body.append(selectionRoot);

const selectionStore = new DocumentStore();
const selectionRegistry = new DocumentRegistry(selectionStore);
const selectionWorkspace = new EditorWorkspace(selectionRoot, selectionRegistry, {
  scheme: 'dark',
  // Цепочка фиксирована: имя «a» (15–16) внутри «a + b» (15–20) внутри строки (1–21).
  selectionRanges: async () => [
    { startLine: 1, startColumn: 15, endLine: 1, endColumn: 16 },
    { startLine: 1, startColumn: 15, endLine: 1, endColumn: 20 },
    { startLine: 1, startColumn: 1, endLine: 1, endColumn: 21 },
  ],
});
const selectionDoc = selectionStore.open('/probe/selection.ts', 'const total = a + b;\n', {
  languageId: 'typescript',
});
selectionWorkspace.open(selectionDoc);

declare global {
  interface Window {
    probeSelection: { workspace: EditorWorkspace; store: DocumentStore; doc: TextDocument };
  }
}

window.probeSelection = { workspace: selectionWorkspace, store: selectionStore, doc: selectionDoc };

// Формулы LaTeX: тот же разборщик markdown, что у предпросмотра и ленты чата. Рисуем
// образец со всеми видами — дробью, корнем, степенью, пределом и матрицей, — чтобы в
// отчёте было видно, что узлы и классы на месте (юнит-тесты проверяют только разбор).
const mathRoot = document.createElement('div');
mathRoot.id = 'probe-math';
mathRoot.style.cssText = 'position: absolute; left: -4000px; top: 0; width: 700px; height: 480px';
document.body.append(mathRoot);

const mathHost = document.createElement('div');
mathRoot.append(mathHost);
const mathRenderer = createMarkdownRenderer({ insertCode: () => false });
mathRenderer.renderInto(
  mathHost,
  [
    'Формула в строке $x^2 + \\frac{a}{b}$ и следом блок:',
    '',
    '$$',
    '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}',
    '$$',
    '',
    'Корень $\\sqrt[3]{x}$ и матрица:',
    '',
    '$$',
    '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}',
    '$$',
    '',
    'Неверная формула $\\frac{a}{$ остаётся исходником.',
  ].join('\n'),
);

declare global {
  interface Window {
    probeMath: { host: HTMLElement };
  }
}

window.probeMath = { host: mathHost };
