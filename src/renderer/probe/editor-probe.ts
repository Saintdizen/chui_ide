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
import { FileDecorations } from '../editor/view/decorations';
import { OwnDiffEditor } from '../editor/host/diff-editor';
import { createProblemPanel } from '../ui/problem-panel';
import type { DiagnosticItem } from '../../shared/api';
import type { SymbolLocation } from '../../shared/lsp-locations';

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
const hover = new HoverWidget(view, buffer, {
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
const symbolsWorkspace = new EditorWorkspace(symbolsRoot, symbolsRegistry, {
  scheme: 'dark',
  symbols: {
    definition: async () => symbolAnswers.definition,
    references: async () => symbolAnswers.references,
  },
  // Подсказки сервера: подставной источник отдаёт готовые элементы — проверяем, что
  // они подмешиваются в список впереди своих слов и вставляются по Enter.
  completionFromLanguage: async () => [
    { label: 'value', kind: 'external' as const, detail: 'переменная', insert: 'value' },
    { label: 'valuableThing', kind: 'external' as const, detail: 'функция', insert: 'valuableThing()' },
  ],
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
    };
  }
}

window.probeSymbols = {
  workspace: symbolsWorkspace,
  store: symbolsStore,
  doc: symbolsDoc,
  answers: symbolAnswers,
  revealed: revealedSpots,
  notices: symbolNotices,
  paletteOpens,
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
