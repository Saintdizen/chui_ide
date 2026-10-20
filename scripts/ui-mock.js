/**
 * Мок моста `window.chui` для проверки интерфейса в обычном браузере.
 *
 * Зачем: поднимать Electron ради скриншота панели дорого, а интерфейсу от main
 * нужен только контракт. Этот файл ставится ДО загрузки приложения и отвечает
 * так же, как `main/ipc/register.ts`, — но данными из памяти, а не с диска.
 *
 * Как запустить проверку:
 *   npx vite --port 5273 --strictPort
 *   # затем в Playwright: page.addInitScript({ path: 'scripts/ui-mock.js' })
 *
 * Мок отвечает за методы, нужные для показа основных экранов: дерево, редактор,
 * поиск, панель git, чат, окна площадки. Есть подсистемы, которых тут нет намеренно —
 * отладчик, git-операции над рабочим каталогом, сеть, git-lfs: они требуют настоящего
 * бэкенда, и подделывать их данными значило бы показывать неправду (список с причинами —
 * в `tests/ui-mock-contract.test.ts`, он же не даёт моку молча отстать от контракта).
 * Незнакомый метод мок не выдумывает, а честно отвечает «нет мока для …».
 */
(() => {
  const ROOT = '/mock/project';
  const MOCK_SHELL = '/bin/bash';
  /**
   * `?fast=1` убирает задержки потока. Нужно для проверки интерфейса: вкладка
   * браузера обычно не активна, и Chromium режет таймеры до одного раза в секунду —
   * с обычными задержками один ответ модели идёт десятки секунд.
   */
  const FAST = new URLSearchParams(location.search).has('fast');

  /* ── данные: дерево повторяет обычный проект на JavaScript ─────────────── */

  const FILES = new Map([
    [
      `${ROOT}/eslint.config.js`,
      `const js = require("@eslint/js");
const globals = require("globals");

/** @type {import("eslint").Linter.Config[]} */
module.exports = [
  {
    ignores: ["node_modules/", "package-lock.json", "coverage/"],
  },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      // Переменная, которую не переприсваивают, объявляется через const:
      // что значение не меняется, а не приходится искать место присваивания.
      "prefer-const": ["error", { destructuring: "all" }],
      // \`var\` не используется: у него область видимости шире блока.
      "no-var": "error",
      // Имена — camelCase: snake_case остался только для внешнего API.
      camelcase: ["error", { properties: "never", ignoreImports: true }],
      "no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          // Служебное имя для осознанно проигнорированной ошибки.
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
];
`,
    ],
    [
      `${ROOT}/package.json`,
      `{
  "name": "mock-project",
  "version": "1.0.0",
  "scripts": {
    "lint": "eslint .",
    "test": "node --test"
  }
}
`,
    ],
    [
      `${ROOT}/README.md`,
      `# mock-project

Проект для проверки интерфейса без Electron.
`,
    ],
    [`${ROOT}/src/queue.js`, `class Queue {\n  #items = [];\n\n  push(item) {\n    this.#items.push(item);\n  }\n}\n`],
    [
      `${ROOT}/scripts/train.py`,
      `"""Обучение небольшой модели."""\n\nimport json\nimport sys\n\n\nclass Trainer:\n    def __init__(self, epochs: int = 3) -> None:\n        self.epochs = epochs\n\n    def fit(self, data: list[float]) -> float:\n        total = 0.0\n        for value in data:\n            total += value * value\n        return total / max(len(data), 1)\n\n\ndef main() -> None:\n    trainer = Trainer(epochs=5)\n    print(json.dumps({"loss": trainer.fit([1.0, 2.0, 3.0])}))\n\n\nif __name__ == "__main__":\n    main()\n`,
    ],
  ]);

  const DIRS = new Map([
    [`${ROOT}`, ['.gitverse', 'app', 'docs', 'scripts', 'src', 'eslint.config.js', 'package.json', 'README.md']],
    [`${ROOT}/.gitverse`, ['config.json', 'logo.svg']],
    [`${ROOT}/app`, ['main.js', 'window.js', 'index.html']],
    [`${ROOT}/docs`, ['architecture.md', 'roadmap.md']],
    [`${ROOT}/scripts`, ['build.mjs', 'dev.mjs', 'train.py']],
    [`${ROOT}/src`, ['queue.js', 'logger.js']],
  ]);

  const kindOf = (path) => (DIRS.has(path) ? 'directory' : 'file');
  const entriesOf = (path) =>
    (DIRS.get(path) ?? []).map((name) => {
      const child = `${path === '/' ? '' : path}/${name}`;
      const size = FILES.get(child)?.length ?? 0;
      return { name, path: child, kind: kindOf(child), size, mtimeMs: 0 };
    });

  /* ── изменение дерева: создание, переименование и удаление ──────────────
     Дерево рисуется по DIRS, а содержимое файлов лежит в FILES, поэтому
     операция правки обязана трогать оба: иначе созданный файл открывается
     в редакторе, но в дереве не появляется — и это читается как «не создался». */

  const parentOf = (target) => target.slice(0, target.lastIndexOf('/'));
  const nameOf = (target) => target.slice(target.lastIndexOf('/') + 1);

  const addChild = (target) => {
    const parent = parentOf(target);
    const list = DIRS.get(parent) ?? [];
    if (!list.includes(nameOf(target))) list.push(nameOf(target));
    DIRS.set(parent, list);
  };

  const dropChild = (target) => {
    const list = DIRS.get(parentOf(target));
    if (!list) return;
    const index = list.indexOf(nameOf(target));
    if (index >= 0) list.splice(index, 1);
  };

  const moveSubtree = (from, to) => {
    for (const key of [...DIRS.keys()]) {
      if (key === from || key.startsWith(`${from}/`)) {
        DIRS.set(to + key.slice(from.length), DIRS.get(key));
        DIRS.delete(key);
      }
    }
    for (const key of [...FILES.keys()]) {
      if (key.startsWith(`${from}/`)) {
        FILES.set(to + key.slice(from.length), FILES.get(key));
        FILES.delete(key);
      }
    }
  };

  /* ── git: состояние в памяти, чтобы панель изменений работала без репозитория ── */

  const gitState = {
    repository: { root: ROOT, branch: 'main', detached: false, head: 'a1b2c3d', ahead: 0, behind: 0 },
    files: [
      { path: `${ROOT}/package.json`, relative: 'package.json', change: 'modified', staged: true, unstaged: false },
      { path: `${ROOT}/docs/roadmap.md`, relative: 'docs/roadmap.md', change: 'added', staged: true, unstaged: false },
      {
        path: `${ROOT}/eslint.config.js`,
        relative: 'eslint.config.js',
        change: 'modified',
        staged: false,
        unstaged: true,
      },
      { path: `${ROOT}/README.md`, relative: 'README.md', change: 'untracked', staged: false, unstaged: true },
      { path: `${ROOT}/src/queue.js`, relative: 'src/queue.js', change: 'deleted', staged: false, unstaged: true },
    ],
  };

  // Отложенные изменения в моке: список, который правится действиями окна stash.
  const mockStash = [{ index: 0, ref: 'stash@{0}', message: 'мок-доработка', branch: 'main' }];
  /** Обсуждение запроса на слияние: мок живёт, пока открыта страница. */
  const mockForgeComments = [
    { author: 'petr', body: 'Посмотрите тесты, пожалуйста.', createdAt: '2024-05-01T11:00:00Z', url: '' },
  ];
  /** Задачи площадки: мок живёт, пока открыто окно. */
  const mockForgeIssues = [
    {
      number: 3,
      title: 'Падает импорт',
      author: 'ivan',
      state: 'open',
      url: 'https://github.com/acme/web/issues/3',
      updatedAt: '2024-05-03T08:00:00Z',
      labels: ['bug'],
    },
  ];
  /** Прогоны CI: мок живёт, пока открыто окно. */
  const mockForgePipelines = [
    {
      id: 42,
      title: 'CI',
      branch: 'main',
      event: 'push',
      state: 'success',
      url: 'https://github.com/acme/web/actions/runs/42',
      createdAt: '2024-05-01T10:00:00Z',
    },
    {
      id: 43,
      title: 'CI',
      branch: 'feat/search',
      event: 'pull_request',
      state: 'failed',
      url: 'https://github.com/acme/web/actions/runs/43',
      createdAt: '2024-05-01T12:00:00Z',
    },
  ];
  /** Уведомления площадки: мок живёт, пока открыто окно. */
  const mockForgeNotifications = [
    {
      id: '9001',
      title: 'Добавить поиск',
      kind: 'pull request',
      reason: 'review_requested',
      unread: true,
      updatedAt: '2024-05-05T08:00:00Z',
      url: 'https://github.com/acme/web/pull/12',
    },
    {
      id: '9002',
      title: 'Падает импорт',
      kind: 'issue',
      reason: 'subscribed',
      unread: false,
      updatedAt: '2024-05-04T08:00:00Z',
      url: 'https://github.com/acme/web/issues/3',
    },
  ];

  const gitBranches = [
    { name: 'main', current: true, remote: false },
    { name: 'feat/git', current: false, remote: false },
    { name: 'origin/main', current: false, remote: true },
  ];

  const fileText = (rel) => FILES.get(`${ROOT}/${rel}`) ?? '';

  const gitStatus = () => ({
    repository: { ...gitState.repository },
    files: gitState.files.map((file) => ({ ...file })),
  });

  // Возвращаем статус: контракт требует результата, а не только push-события.
  const gitChanged = () => {
    const status = gitStatus();
    push('git:changed', status);
    return status;
  };

  const setStaged = (paths, staged) => {
    for (const file of gitState.files) {
      if (!paths.includes(file.path)) continue;
      file.staged = staged;
      file.unstaged = !staged;
    }
    return gitChanged();
  };

  /* ── стартовое окно: корень, открытый «в main», и история проектов ─────── */

  // Проект открыт сразу: так проверка интерфейса идёт по тому же пути, что
  // в жизни — дерево, вкладки файлов, чат рядом с ними.
  let currentRoot = ROOT;
  const recent = [
    { path: ROOT, name: 'project', exists: true },
    { path: '/mock/gone-project', name: 'gone-project', exists: false },
  ];

  /* ── настройки: те же ключи, что в `main/settings.ts` ──────────────────── */

  /** Красный пиксель: миниатюра в чипе видна, файл при этом крошечный. */
  const TINY_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

  /** Настройки проекта из `.chui_ide` — в моке отдельное хранилище, как в main. */
  const projectSettings = {};

  const settings = {
    ai: {
      providers: [
        {
          id: 'openai',
          label: 'OpenAI',
          baseUrl: 'https://api.openai.com/v1',
          // o3-mini — из семейства с усилием размышления: на нём видно,
          // как контрол включённого эффорта отличается от выключенного.
          models: ['gpt-4o-mini', 'gpt-4o', 'o3-mini'],
          defaultModel: 'gpt-4o-mini',
          hasApiKey: false,
        },
        {
          id: 'groq',
          label: 'Groq',
          baseUrl: 'https://api.groq.com/openai/v1',
          models: ['llama-3.3-70b'],
          defaultModel: 'llama-3.3-70b',
          hasApiKey: false,
        },
      ],
      activeProviderId: 'openai',
      activeModel: 'gpt-4o-mini',
      temperature: 0.2,
      maxTokens: 2048,
      compactAtTokens: 100_000,
      systemPrompt: 'Ты ассистент внутри редактора.',
      maxSteps: 8,
      maxAutopilotSteps: 24,
      // Автодополнение выключено, как и в main: включается осознанно.
      inlineCompletion: { enabled: false, debounceMs: 350 },
      // Усилие размышления и веб-поиск: тумблеры композера читают их напрямую.
      reasoningEffort: 'off',
      webSearch: { enabled: false, provider: 'searxng', endpoint: '', hasApiKey: false },
      // Чтение страниц по ссылке: как main — есть всегда, выключено по умолчанию.
      webFetch: { enabled: false },
      // Браузер агента: как main — секция есть всегда, по умолчанию выключена.
      browser: { enabled: false, executable: '', headless: true },
      // Песочница агента: как main — выключена, образ по умолчанию.
      sandbox: { enabled: false, image: 'python:3.12-slim', workdir: '/workspace', network: true },
    },
    editor: {
      tabSize: 2,
      fontSize: 14,
      insertSpaces: true,
      languageIndent: true,
      formatOnSave: false,
      // Правки текста при сохранении: как в main — выключены по умолчанию.
      trimTrailingWhitespace: false,
      insertFinalNewline: false,
      // Автосохранение: как в main — выключено, пока не попросят.
      autoSave: 'off',
      autoSaveDelayMs: 1000,
      // Направляющие и показ невидимых знаков: как в main.
      rulers: [80, 120],
      renderWhitespace: 'none',
      minimap: false,
      wordWrap: false,
      fontLigatures: false,
      // Свои сниппеты: как в main — по умолчанию пусто, набор знает редактор.
      snippets: [],
    },
    // Проводник и запуск: мок повторяет контракт настроек из shared/api.ts.
    explorer: {
      icons: true,
      showHidden: true,
      foldersFirst: true,
      sort: 'name',
      indent: 12,
      rowDensity: 'normal',
      gitDecorations: true,
      folderChangeDot: true,
      dimIgnored: true,
      openOnSingleClick: false,
      confirmDelete: true,
      exclude: [],
      byRoot: {},
      badges: [],
    },
    run: { pythonPath: '', packageManager: 'auto', saveBeforeRun: true, pythonByRoot: {} },
    // Языковые серверы: как main — секция есть всегда, по умолчанию выключена.
    lsp: { enabled: false, servers: [] },
    // Git: режим pull по умолчанию — как в main (поведение самого git).
    git: { pullMode: 'default', saveBeforeCommit: true },
    // Изменённые горячие клавиши: по умолчанию пусто — сочетания берутся из кода.
    keybindings: { overrides: [] },
    appearance: { uiScale: 1, customTheme: null },
    // Макет рабочей области: размеры и видимость панелей (общий для всех проектов).
    layout: {
      sidebarSize: 260,
      rightSize: 400,
      dockSize: 260,
      sidebarVisible: true,
      rightVisible: true,
      dockVisible: false,
    },
    // История открытых папок — для стартового окна; в моке пусто.
    workspace: { recent: [], favorites: [], remoteRoots: [] },
  };

  /* ── шина: события вызова и широковещательные push-сообщения ───────────── */

  const rpcEventListeners = new Set();
  const pushListeners = new Set();
  const hostListeners = new Set();
  const pendingHost = new Map();
  let listenerId = 0;
  let hostSeq = 0;
  /** Как main: отмена вызова прерывает выполняющийся стрим. */
  let cancelRequested = false;

  /** Как main: спросить renderer и дождаться ответа хостовым вызовом. */
  const askHost = (method, params) => {
    hostSeq += 1;
    const id = `mock-h${hostSeq}`;
    return new Promise((resolve) => {
      pendingHost.set(id, resolve);
      for (const listener of [...hostListeners]) listener({ id, method, params });
    });
  };

  const emit = (id, event, payload) => {
    for (const listener of rpcEventListeners) listener({ id, event, payload });
  };
  const push = (topic, payload) => {
    for (const listener of pushListeners) listener({ topic, payload });
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, FAST ? Math.min(ms, 4) : ms));

  /**
   * Приблизительная замена структурного поиска: образец переводим в регулярку —
   * `$имя` это один кусок, `$имя...` — последовательность, пробелы ничего не значат.
   * Это мок для взгляда на интерфейс, а не повторение настоящего разбора
   * (`src/shared/structural-search.ts`): точность здесь не нужна.
   */
  const structuralRegex = (pattern) => {
    const names = [];
    let source = '';
    let i = 0;
    while (i < pattern.length) {
      const ch = pattern[i];
      if (ch === '$' && pattern[i + 1] === '$') {
        source += '\\$';
        i += 2;
        continue;
      }
      if (ch === '$') {
        let j = i + 1;
        while (j < pattern.length && /[A-Za-z0-9_]/.test(pattern[j])) j += 1;
        const name = pattern.slice(i + 1, j);
        if (!name) {
          source += '\\$';
          i += 1;
          continue;
        }
        const seq = pattern.startsWith('...', j);
        source += seq ? '([\\s\\S]*?)' : '([\\w.]+)';
        names.push(name);
        i = seq ? j + 3 : j;
        continue;
      }
      if (/\s/.test(ch)) {
        source += '\\s*';
        while (i < pattern.length && /\s/.test(pattern[i])) i += 1;
        continue;
      }
      source += /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
      i += 1;
    }
    return { source, names };
  };

  const structuralMatches = (text, pattern) => {
    const { source, names } = structuralRegex(pattern);
    if (!source) return [];
    let regex;
    try {
      regex = new RegExp(source, 'g');
    } catch {
      return [];
    }
    const out = [];
    for (const match of text.matchAll(regex)) {
      const captures = {};
      names.forEach((name, index) => {
        captures[name] = match[index + 1] ?? '';
      });
      const start = match.index ?? 0;
      out.push({ start, end: start + match[0].length, text: match[0], captures });
    }
    return out;
  };

  const expandReplacement = (replacement, captures) => {
    let out = '';
    let i = 0;
    while (i < replacement.length) {
      const ch = replacement[i];
      if (ch !== '$') {
        out += ch;
        i += 1;
        continue;
      }
      if (replacement[i + 1] === '$') {
        out += '$';
        i += 2;
        continue;
      }
      let j = i + 1;
      while (j < replacement.length && /[A-Za-z0-9_]/.test(replacement[j])) j += 1;
      const name = replacement.slice(i + 1, j);
      if (name && Object.hasOwn(captures, name)) {
        out += captures[name];
        i = j;
        continue;
      }
      out += ch;
      i += 1;
    }
    return out;
  };

  /**
   * Приблизительный разбор экспортов для мока: JS/TS — по строкам с `export`, Python —
   * `__all__` и объявления верхнего уровня. Это мок для взгляда на интерфейс, а не
   * повторение настоящего разбора (`src/shared/symbol-exports.ts`).
   */
  /**
   * Приблизительный разбор наследования для мока: JS/TS — `class ... extends/implements`,
   * `interface ... extends`; Python — родители в скобках. Мок для взгляда на интерфейс,
   * а не повторение настоящего разбора (`src/shared/type-inheritance.ts`).
   */
  const mockTypeDeclarations = (text) => {
    const out = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const trimmed = lines[i].trim();
      if (/^\s/.test(lines[i])) continue;
      const line = i + 1;
      const iface = /^(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)\b([\s\S]*)$/.exec(trimmed);
      if (iface) {
        const ext = /\bextends\s+([^{]+)/.exec(iface[2]);
        out.push({
          name: iface[1],
          line,
          kind: 'interface',
          bases: (ext ? ext[1] : '')
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean),
        });
        continue;
      }
      const klass =
        /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)([\s\S]*)$/.exec(
          trimmed,
        );
      if (klass) {
        const bases = [];
        const ext = /\bextends\s+([A-Za-z_$][\w$.]*)/.exec(klass[2]);
        if (ext) bases.push(ext[1]);
        const impl = /\bimplements\s+([^{]+)/.exec(klass[2]);
        if (impl) for (const part of impl[1].split(',')) if (part.trim()) bases.push(part.trim());
        out.push({ name: klass[1], line, kind: 'class', bases });
        continue;
      }
      const py = /^class\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?\s*:/.exec(trimmed);
      if (py) {
        const bases = (py[2] ?? '')
          .split(',')
          .map((x) => x.trim())
          .filter((x) => x && !x.includes('=') && !x.startsWith('*'));
        out.push({ name: py[1], line, kind: 'class', bases });
      }
    }
    return out;
  };

  const normalizeBase = (base) => {
    const withoutGeneric = base.replace(/[<[].*$/, '').trim();
    const dot = withoutGeneric.lastIndexOf('.');
    return (dot < 0 ? withoutGeneric : withoutGeneric.slice(dot + 1)).trim();
  };

  const mockExportedNames = (text) => {
    const found = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const lineNo = i + 1;
      const trimmed = line.trim();
      const decl =
        /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(
          trimmed,
        );
      if (decl) {
        found.push({ name: decl[1], line: lineNo, kind: 'declaration' });
        continue;
      }
      if (/^export\s+default\b/.test(trimmed)) {
        found.push({ name: 'default', line: lineNo, kind: 'default' });
        continue;
      }
      const braces = /^export\s*(?:type\s*)?\{([^}]*)\}/.exec(trimmed);
      if (braces) {
        for (const spec of braces[1].split(',')) {
          const m = /^\s*([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(spec);
          if (m) found.push({ name: m[2] ?? m[1], line: lineNo, kind: 'named' });
        }
        continue;
      }
      if (/^\s/.test(line)) continue;
      const py = /^(?:async\s+)?def\s+([A-Za-z_]\w*)|^class\s+([A-Za-z_]\w*)/.exec(trimmed);
      if (py && !String(py[1] ?? py[2]).startsWith('_')) {
        found.push({ name: py[1] ?? py[2], line: lineNo, kind: 'declaration' });
      }
    }
    return found;
  };

  const replaceStructural = (text, pattern, replacement) => {
    const { source, names } = structuralRegex(pattern);
    if (!source) return { text, count: 0 };
    let regex;
    try {
      regex = new RegExp(source, 'g');
    } catch {
      return { text, count: 0 };
    }
    let count = 0;
    const next = text.replace(regex, (...args) => {
      count += 1;
      const captures = {};
      names.forEach((name, index) => {
        captures[name] = args[index + 1] ?? '';
      });
      return expandReplacement(replacement, captures);
    });
    return { text: next, count };
  };

  /* ── методы ───────────────────────────────────────────────────────────── */

  const sessions = new Map();
  // Сессии проектов: как main, по корню рабочей папки.
  const workspaceSessions = new Map();
  // Беседы чата: мок держит их в памяти по корню проекта — смена папки и
  // обратная загрузка работают, а перезагрузка страницы их, как и в жизни, теряет.
  const savedChats = new Map();
  // Расписание задач: настоящие живут в `.chui/schedules.json` и срабатывают по
  // часам main, а здесь — только список для просмотра окна.
  let mockSchedules = [];

  const methods = {
    'app.info': () => ({
      appVersion: '0.1.0-mock',
      electron: '44.7.0-mock',
      chrome: '152.0.0-mock',
      node: '24.0.0-mock',
      platform: 'linux',
    }),

    'dialog.pickFolder': () => ({ path: ROOT }),
    // Подтверждение в проверке не мешает: мок соглашается сразу.
    'dialog.confirm': () => ({ confirmed: true }),
    // Save As: пробник отвечает файлом с суффиксом рядом с исходным — так видно,
    // что вкладка переехала на новый путь, а прежний файл остался.
    'dialog.saveFile': (params) => ({ path: `${params.defaultPath ?? ROOT}.copy` }),

    // Diff будущего коммита: для предпросмотра хватает правки одного файла.
    // Блоки изменений файла: в моке один блок на строке 1 — по нему и открывается меню.
    'git.fileHunks': () => ({
      unstaged: [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 2 }],
      staged: [],
    }),
    'git.discardHunk': () => gitChanged(),
    'git.commitDiff': () => ({
      diff: 'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1,2 @@\n const a = 1;\n+const b = 2;\n',
      staged: true,
      truncated: false,
      files: 1,
      untracked: [],
    }),
    'git.status': () => gitStatus(),
    'git.init': () => gitChanged(),
    'git.stage': (params) => setStaged(params.paths, true),
    'git.unstage': (params) => setStaged(params.paths, false),
    // Частичное индексирование: в моке правок по блокам нет — переносим файл целиком.
    'git.stageHunk': (params) => setStaged([params.path], true),
    'git.unstageHunk': (params) => setStaged([params.path], false),
    'git.discard': (params) => {
      gitState.files = gitState.files.filter((file) => !params.paths.includes(file.path));
      return gitChanged();
    },
    'git.commit': (params) => {
      const committed = gitState.files.filter((file) => file.staged);
      gitState.files = gitState.files.filter((file) => !file.staged);
      gitState.repository.head = Math.random().toString(16).slice(2, 9);
      gitChanged();
      return { hash: gitState.repository.head, summary: params.message, committed: committed.length };
    },
    'git.diff': (params) => {
      const file = gitState.files.find((item) => item.path === params.path);
      const text = fileText(file?.relative ?? '');
      // Оригинал делаем отличимым: без последней строки, как было до правки.
      const lines = text.split('\n');
      const original = lines.slice(0, Math.max(1, lines.length - 2)).join('\n') + '\n';
      // Один блок изменений — чтобы в проверке была видна кнопка индексирования.
      const hunks = [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 }];
      return { original, modified: text, hunks };
    },
    // Blame и история: мок отвечает одной строкой и одним коммитом — этого хватает,
    // чтобы проверить, что подпись и список в UI собираются.
    'git.blame': (params) => [
      { line: params.startLine ?? 1, hash: 'abc1234', author: 'Мок', date: '2024-01-02', summary: 'правка', text: '' },
    ],
    'git.log': () => [{ hash: 'abc1234', author: 'Мок', date: '2024-01-02', summary: 'первый коммит' }],
    // База для полосок изменений: в моке считаем, что в HEAD файл был короче.
    'git.headText': () => 'строка первая\nстрока вторая\n',
    // Отложенные изменения: список и действия.
    'git.stashList': () => mockStash.map((entry, index) => ({ ...entry, index, ref: `stash@{${index}}` })),
    'git.stashSave': (params) => {
      gitState.files = [];
      mockStash.unshift({ index: 0, ref: 'stash@{0}', message: params.message || 'WIP', branch: 'main' });
      return gitChanged();
    },
    'git.stashApply': () => gitChanged(),
    'git.stashPop': () => {
      mockStash.shift();
      return gitChanged();
    },
    'git.stashDrop': (params) => {
      mockStash.splice(params.index, 1);
      return gitChanged();
    },
    'git.stashShow': () => 'diff --git a/README.md b/README.md\n@@ -1 +1 @@\n-старое\n+новое\n',
    // Отдельные коммиты и теги: операции меняют состояние в памяти.
    'git.cherryPick': () => gitChanged(),
    'git.revert': () => gitChanged(),
    'git.reset': () => gitChanged(),
    'git.tags': () => [{ name: 'v0.0.6', commit: 'a1b2c3d', subject: 'релиз' }],
    'git.createTag': () => gitChanged(),
    'git.deleteTag': () => gitChanged(),
    'git.pushTag': () => ({ ok: true, message: 'мок: тег отправлен', status: gitState }),
    'git.deleteBranch': () => gitChanged(),
    'git.renameBranch': () => gitChanged(),
    'git.ignore': (params) => {
      gitState.files = gitState.files.filter((file) => !params.paths.includes(file.path));
      return gitChanged();
    },
    'git.reflog': () => [
      { hash: 'a1b2c3d', ref: 'HEAD@{0}', date: '2024-01-02', action: 'commit: первый коммит' },
      { hash: 'b2c3d4e', ref: 'HEAD@{1}', date: '2024-01-01', action: 'reset: moving to HEAD~1' },
    ],
    'git.logGraph': () => '* a1b2c3d (HEAD -> main) первый коммит\n* b2c3d4e начало\n',
    // Стороны конфликта: в моке все три — один и тот же текст файла.
    'git.conflictParts': (params) => {
      const file = gitState.files.find((item) => item.path === params.path);
      const text = fileText(file?.relative ?? '');
      return { base: text, ours: text, theirs: text };
    },
    'git.markResolved': (params) => setStaged([params.path], true),
    'git.branches': () => gitBranches.map((branch) => ({ ...branch })),
    'git.checkout': (params) => {
      gitState.repository.branch = params.name;
      for (const branch of gitBranches) branch.current = branch.name === params.name;
      return gitChanged();
    },

    'git.forgeInfo': () => ({
      repo: { platform: 'github', host: 'github.com', owner: 'acme', repo: 'web' },
      remote: 'origin',
      cli: 'gh',
      cliAvailable: true,
      authenticated: true,
      requests: [
        {
          number: 12,
          title: 'Добавить поиск',
          author: 'ivan',
          state: 'open',
          sourceBranch: 'feat/search',
          targetBranch: 'main',
          url: 'https://github.com/acme/web/pull/12',
          updatedAt: '2024-05-01T10:00:00Z',
          labels: ['enhancement'],
        },
      ],
      note: '',
    }),
    'git.forgeCreate': async () => {
      await sleep(120);
      return handlers['git.forgeInfo']();
    },
    'git.forgeCheckout': (params) => {
      gitState.repository.branch = `pr-${params.number}`;
      return gitChanged();
    },
    'git.forgeComments': async () => {
      await sleep(120);
      return mockForgeComments.map((comment) => ({ ...comment }));
    },
    'git.forgeComment': async (params) => {
      await sleep(120);
      mockForgeComments.push({ author: 'вы', body: params.body, createdAt: '2024-05-01T12:00:00Z', url: '' });
      return mockForgeComments.map((comment) => ({ ...comment }));
    },
    'git.forgeIssues': async () => {
      await sleep(120);
      return mockForgeIssues.map((issue) => ({ ...issue }));
    },
    'git.forgeIssueCreate': async (params) => {
      await sleep(120);
      mockForgeIssues.push({
        number: mockForgeIssues.length + 1,
        title: params.title,
        author: 'вы',
        state: 'open',
        url: '',
        updatedAt: '',
        labels: [],
      });
      return mockForgeIssues.map((issue) => ({ ...issue }));
    },
    'git.forgeIssueClose': async (params) => {
      await sleep(120);
      const issue = mockForgeIssues.find((item) => item.number === params.number);
      if (issue) issue.state = 'closed';
      return mockForgeIssues.map((item) => ({ ...item }));
    },
    'git.forgeIssueComments': async () => {
      await sleep(120);
      return mockForgeComments.map((comment) => ({ ...comment }));
    },
    'git.forgeIssueComment': async (params) => {
      await sleep(120);
      mockForgeComments.push({ author: 'вы', body: params.body, createdAt: '2024-05-01T12:00:00Z', url: '' });
      return mockForgeComments.map((comment) => ({ ...comment }));
    },
    'git.forgePipelines': async () => {
      await sleep(120);
      return mockForgePipelines.map((run) => ({ ...run }));
    },
    'git.forgePipelineRerun': async () => {
      await sleep(120);
      return mockForgePipelines.map((run) => ({ ...run }));
    },
    'git.forgeNotifications': async () => {
      await sleep(120);
      return mockForgeNotifications.map((note) => ({ ...note }));
    },
    'git.forgeNotificationRead': async (params) => {
      await sleep(120);
      const note = mockForgeNotifications.find((item) => item.id === params.id);
      if (note) note.unread = false;
      return mockForgeNotifications.map((item) => ({ ...item }));
    },

    'workspace.current': () => ({ root: currentRoot }),

    'session.load': (params) =>
      workspaceSessions.get(params.root) ?? {
        tabs: [],
        expanded: [],
        dockVisible: false,
        sidebarVisible: true,
        rightVisible: true,
      },
    'session.save': (params) => {
      workspaceSessions.set(params.root, params.state);
    },

    'app.recentProjects': () => recent.map((item) => ({ ...item })),
    'app.forgetProject': (params) => {
      const index = recent.findIndex((item) => item.path === params.path);
      if (index >= 0) recent.splice(index, 1);
      return recent.map((item) => ({ ...item }));
    },
    'app.openProject': (params) => {
      currentRoot = params.path;
      return { root: params.path, name: params.path.split('/').filter(Boolean).pop() ?? params.path };
    },
    // Закрытие проекта поднимает стартовое окно в main — в браузерном просмотре
    // его нет, поэтому мок просто принимает вызов.
    'app.closeProject': () => undefined,
    // Создание проекта пишет файлы на диск: в браузере диска нет, поэтому мок
    // подтверждает путь — как если бы папка была создана.
    'app.createProject': (params) => ({ path: `${params.directory}/${params.name}` }),
    'git.clone': async (params, id) => {
      for (const line of ['Cloning into…', 'remote: Enumerating objects', 'Receiving objects: 100% (12/12), done.']) {
        await sleep(80);
        emit(id, 'progress', { line });
      }
      return { path: params.directory };
    },

    'workspace.open': (params) => {
      currentRoot = params.path;
      return {
        root: params.path,
        name: params.path.split('/').filter(Boolean).pop() ?? params.path,
        entries: entriesOf(params.path),
      };
    },
    'workspace.readDir': (params) => entriesOf(params.path),
    // Как main: замена по всем файлам проекта, возвращает изменённые пути.
    'workspace.replace': (params) => {
      const escaped = params.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const source = params.isRegex ? params.query : escaped;
      const flags = params.caseSensitive ? 'g' : 'gi';
      let pattern;
      try {
        pattern = new RegExp(source, flags);
      } catch {
        return { files: [], replaced: 0 };
      }
      const files = [];
      let replaced = 0;
      for (const [full, text] of FILES) {
        if (!full.startsWith(`${ROOT}/`)) continue;
        const hits = (text.match(pattern) ?? []).length;
        if (hits === 0) continue;
        FILES.set(full, text.replace(pattern, params.replacement));
        files.push(full);
        replaced += hits;
        push('workspace:changed', { root: currentRoot, path: full });
      }
      return { files, replaced };
    },
    // Как main: поиск по структуре кода по всему проекту — предпросмотр, без правок.
    'workspace.structuralSearch': (params) => {
      const files = [];
      let total = 0;
      let scanned = 0;
      for (const [full, text] of FILES) {
        if (!full.startsWith(`${ROOT}/`)) continue;
        scanned += 1;
        const matches = structuralMatches(text, params.pattern);
        if (matches.length === 0) continue;
        total += matches.length;
        files.push({ path: full, count: matches.length, matches: matches.slice(0, 20) });
      }
      return { files, total, scanned };
    },
    // Как main: замена по структуре по всему проекту, возвращает изменённые пути.
    'workspace.structuralReplace': (params) => {
      const changed = [];
      let replaced = 0;
      for (const [full, text] of FILES) {
        if (!full.startsWith(`${ROOT}/`)) continue;
        const result = replaceStructural(text, params.pattern, params.replacement);
        if (result.count === 0) continue;
        FILES.set(full, result.text);
        changed.push(full);
        replaced += result.count;
        push('workspace:changed', { root: currentRoot, path: full });
      }
      return { files: changed, replaced };
    },
    // Как main: где имя объявлено экспортом — по строкам, без дерева разбора.
    'workspace.findExports': (params) => {
      const name = String(params.name ?? '').trim();
      const files = [];
      let total = 0;
      let scanned = 0;
      for (const [full, text] of FILES) {
        if (!full.startsWith(`${ROOT}/`)) continue;
        if (!/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py)$/.test(full)) continue;
        scanned += 1;
        const entries = mockExportedNames(text).filter((entry) => entry.name === name);
        if (entries.length === 0) continue;
        total += entries.length;
        files.push({ path: full, entries });
      }
      return { name, files, total, scanned };
    },
    // Как main: наследование имени по проекту — свой разбор строк.
    'workspace.findInheritance': (params) => {
      const name = String(params.name ?? '').trim();
      const direction = params.direction === 'supertypes' ? 'supertypes' : 'subtypes';
      const target = normalizeBase(name);
      const files = [];
      let total = 0;
      let scanned = 0;
      for (const [full, text] of FILES) {
        if (!full.startsWith(`${ROOT}/`)) continue;
        if (!/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py)$/.test(full)) continue;
        scanned += 1;
        const decls = mockTypeDeclarations(text);
        const entries =
          direction === 'subtypes'
            ? decls.filter((d) => d.bases.some((b) => normalizeBase(b) === target))
            : decls.filter((d) => d.name === name);
        if (entries.length === 0) continue;
        total += entries.length;
        files.push({ path: full, entries });
      }
      return { name, direction, files, total, scanned };
    },
    // Как main: относительные (POSIX) пути всех файлов — для быстрого открывателя.
    'workspace.listFiles': () =>
      [...FILES.keys()]
        .filter((full) => full.startsWith(`${ROOT}/`))
        .map((full) => full.slice(ROOT.length + 1))
        .sort(),
    'workspace.readFile': (params) => {
      const text = FILES.get(params.path) ?? '';
      // Как main: размер и признак «только чтение» — по ним редактор решает, править ли файл.
      return { text, mtimeMs: Date.now(), size: text.length, readOnly: false };
    },
    // Вьюер картинок: отдаём крошечную картинку — в браузере файлов с диска нет.
    'workspace.readImage': () => {
      const dataUrl =
        'data:image/png;base64,' +
        'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHUlEQVR42mNk+M9Qz0AEYBxVSF+FjI' +
        'MjCxkTFhUCAF1uCwG7vFcYAAAAAElFTkSuQmCC';
      return { mime: 'image/png', bytes: 84, dataUrl };
    },
    // Предпросмотр документа Office: файловой системы в браузере нет, поэтому отдаём
    // уже разобранный вид — важно, что экран ходит в main и рисует ответ.
    'workspace.readOffice': () => ({
      kind: 'docx',
      bytes: 12_288,
      blocks: [
        { kind: 'heading', level: 1, text: 'Договор' },
        { kind: 'paragraph', text: 'Содержимое из подменённого RPC.' },
      ],
      truncated: false,
    }),
    'workspace.writeFile': (params) => {
      FILES.set(params.path, params.text ?? '');
      // Как main: сохранение файла — это изменение в рабочей папке, о нём
      // узнаёт и дерево, и открытый документ (перечитывает renderer).
      push('workspace:changed', { root: currentRoot, path: params.path });
      return { mtimeMs: Date.now() };
    },
    // Как настоящая ФС: несуществующий путь — ошибка. Иначе определение
    // инструментов проекта (`.venv/bin/python`, файлы блокировки) «находит»
    // что угодно и показывает не тот интерпретатор.
    'workspace.stat': (params) => {
      if (!FILES.has(params.path) && !DIRS.has(params.path)) {
        throw new Error(`Файл не найден: ${params.path}`);
      }
      return {
        path: params.path,
        kind: kindOf(params.path),
        size: FILES.get(params.path)?.length ?? 0,
        mtimeMs: Date.now(),
      };
    },
    'workspace.search': (params) => {
      const hits = [];
      for (const [path, text] of FILES) {
        text.split('\n').forEach((line, index) => {
          const column = line.indexOf(params.query);
          if (column >= 0) {
            hits.push({ path, line: index + 1, column: column + 1, text: line.trim() });
          }
        });
      }
      return { hits, truncated: false, scanned: FILES.size };
    },
    'workspace.compareFolders': (params) => ({
      left: params.left,
      right: params.right,
      files: [{ path: 'diff.ts', change: 'modified' }],
      identical: 0,
      truncated: false,
    }),
    'workspace.createFile': (params) => {
      FILES.set(params.path, params.contents ?? '');
      addChild(params.path);
      return { path: params.path };
    },
    'workspace.createDir': (params) => {
      DIRS.set(params.path, []);
      addChild(params.path);
      return { path: params.path };
    },
    'workspace.rename': (params) => {
      const text = FILES.get(params.from);
      if (text !== undefined) {
        FILES.delete(params.from);
        FILES.set(params.to, text);
      }
      if (DIRS.has(params.from)) moveSubtree(params.from, params.to);
      dropChild(params.from);
      addChild(params.to);
      return { path: params.to };
    },
    'workspace.copy': (params) => {
      const text = FILES.get(params.from);
      if (text !== undefined) FILES.set(params.to, text);
      addChild(params.to);
      return { path: params.to };
    },
    'workspace.trash': (params) => {
      FILES.delete(params.path);
      for (const key of [...DIRS.keys()]) {
        if (key === params.path || key.startsWith(`${params.path}/`)) DIRS.delete(key);
      }
      for (const key of [...FILES.keys()]) {
        if (key.startsWith(`${params.path}/`)) FILES.delete(key);
      }
      dropChild(params.path);
    },

    // Картинку отдаём настоящую (крошечный PNG): по ней видно, что миниатюра
    // в чипе действительно рисуется, а не только имя файла.
    'dialog.pickImages': () => [{ name: 'screenshot.png', mime: 'image/png', bytes: 68, dataUrl: TINY_PNG }],

    'terminal.create': (params) => {
      const id = `t${sessions.size + 1}`;
      const session = { id, title: 'bash', cwd: params.cwd ?? ROOT, shell: MOCK_SHELL, pid: 1000 + sessions.size };
      sessions.set(id, session);
      // Приветствие оболочки — чтобы в панели было видно текст, а не пустоту.
      setTimeout(() => push('terminal:data', { id, data: `\u001b[38;5;245m${MOCK_SHELL} (мок)\u001b[0m\r\n$ ` }), 30);
      return session;
    },
    'terminal.write': (params) => {
      // Эхо и ответ на Enter: панели нужно проверить вывод, а не работу shell.
      const echo = params.data === '\r' ? `\r\n$ ` : params.data;
      push('terminal:data', { id: params.id, data: echo });
    },
    'terminal.resize': () => undefined,
    'terminal.kill': (params) => {
      sessions.delete(params.id);
      push('terminal:exit', { id: params.id, exitCode: 0 });
    },
    'shell.revealInOS': () => ({ ok: true }),
    'shell.openTerminal': () => ({ ok: true, command: 'gnome-terminal' }),
    'shell.openPath': () => ({ ok: true }),
    'window.getState': () => ({ maximized: false, fullScreen: false, platform: 'linux', customControls: true }),
    'window.minimize': () => undefined,
    'window.toggleMaximize': () => {
      const state = { maximized: true, fullScreen: false, platform: 'linux', customControls: true };
      push('window:state', state);
      return state;
    },
    'window.close': () => undefined,
    'menu.role': () => undefined,

    'settings.get': () => structuredClone(settings),
    'settings.update': (params) => {
      const { provider, removeProviderId, ...ai } = params.ai ?? {};
      Object.assign(settings.ai, ai);
      Object.assign(settings.editor, params.editor ?? {});
      Object.assign(settings.explorer, params.explorer ?? {});
      Object.assign(settings.run, params.run ?? {});
      Object.assign(settings.appearance, params.appearance ?? {});
      Object.assign(settings.layout, params.layout ?? {});
      Object.assign(settings.lsp, params.lsp ?? {});

      // Провайдеров добавляем и убираем так же, как это делает SettingsStore.
      if (provider) {
        const existing = settings.ai.providers.find((item) => item.id === provider.id);
        if (existing) Object.assign(existing, provider);
        else settings.ai.providers.push({ models: [], ...provider });
      }
      if (removeProviderId) {
        settings.ai.providers = settings.ai.providers.filter((item) => item.id !== removeProviderId);
      }

      // Тему из файла main сообщает push-событием: от неё зависят редактор, терминал
      // и подсветка кода в чате, поэтому мок обязан её отдавать так же.
      if (params.appearance && 'customTheme' in params.appearance) {
        push('theme:changed', { customTheme: settings.appearance.customTheme ?? null });
      }

      const snapshot = structuredClone(settings);
      push('settings:changed', snapshot);
      return snapshot;
    },
    'settings.revealFile': () => ({ path: '/mock/config/settings.json' }),

    // Тема из файла: мок сразу берёт готовую тему, чтобы кнопки в настройках
    // можно было проверить без реального диалога выбора файла.
    'theme.import': () => {
      settings.appearance.customTheme = {
        name: 'Мок-тема',
        chrome: { background: '#101418', accent: '#7c5cff' },
        tokens: { keyword: '#ff79c6' },
      };
      push('theme:changed', { customTheme: settings.appearance.customTheme });
      const snapshot = structuredClone(settings);
      push('settings:changed', snapshot);
      return { settings: snapshot, name: settings.appearance.customTheme.name };
    },
    // Удалённые файловые системы: мок отвечает так, будто ssh/wsl/docker есть, а
    // папка — с двумя уровнями и файлом. Нужно, чтобы блок «Удалённые папки» и окно
    // просмотра удалённого файла можно было проверить в браузере.
    'remote.check': () => ({ ok: true, detail: 'mock client 1.0' }),
    'remote.readDir': (params) => {
      if (String(params.address).endsWith('/srv/app')) {
        return [
          { name: 'src', path: `${params.address}/src`, kind: 'directory', size: 0, mtimeMs: Date.now() },
          { name: 'README.md', path: `${params.address}/README.md`, kind: 'file', size: 12, mtimeMs: Date.now() },
        ];
      }
      return [{ name: 'main.ts', path: `${params.address}/main.ts`, kind: 'file', size: 12, mtimeMs: Date.now() }];
    },
    'remote.readFile': (params) => ({ text: `// мок ${params.address}\n`, truncated: false }),
    'remote.writeFile': () => ({ ok: true }),
    'remote.stat': () => ({ exists: true, kind: 'file', size: 12, mtimeMs: Date.now() }),
    'remote.mkdir': () => ({ ok: true }),
    'remote.rename': () => ({ ok: true }),
    'remote.remove': () => ({ ok: true }),
    'theme.export': () => ({ path: '/mock/config/chui-theme.json' }),
    // Набор значков дерева: мок берёт готовые правила — как будто файл прочитан.
    'explorer.importBadges': () => {
      settings.explorer.badges = [
        { pattern: '*.generated.*', badge: 'gen', color: 'orange', title: 'Сгенерированный файл' },
        { pattern: 'src/api/**', badge: '', color: 'blue', title: 'Только через клиент API' },
      ];
      const snapshot = structuredClone(settings);
      push('settings:changed', snapshot);
      return { settings: snapshot, count: settings.explorer.badges.length };
    },
    'theme.clear': () => {
      settings.appearance.customTheme = null;
      push('theme:changed', { customTheme: null });
      const snapshot = structuredClone(settings);
      push('settings:changed', snapshot);
      return snapshot;
    },

    'ai.setApiKey': (params) => {
      const provider = settings.ai.providers.find((item) => item.id === params.providerId);
      if (provider) provider.hasApiKey = true;
      return structuredClone(settings);
    },
    'ai.clearApiKey': (params) => {
      const provider = settings.ai.providers.find((item) => item.id === params.providerId);
      if (provider) provider.hasApiKey = false;
      return structuredClone(settings);
    },
    // Языковые серверы в моке не запускаются: методы принимают вызовы и молчат.
    'lsp.open': () => undefined,
    'lsp.change': () => undefined,
    'lsp.close': () => undefined,
    'lsp.restart': () => ({ running: [], servers: [], failed: [] }),
    'lsp.prewarm': () => undefined,
    'lsp.status': () => ({
      running: ['python'],
      servers: [{ language: 'python', label: 'Pyright', origin: 'bundled' }],
      failed: [],
    }),
    // Подсказок в моке нет: пустой ответ — как у сервера без таких возможностей.
    // Исключение — структура файла: мок отдаёт силуэт, чтобы панель Outline показывалась.
    'lsp.request': (params) => {
      if (params?.method === 'textDocument/documentSymbol') {
        return [
          {
            name: 'main',
            kind: 12,
            range: { start: { line: 4, character: 0 }, end: { line: 12, character: 0 } },
            selectionRange: { start: { line: 4, character: 4 }, end: { line: 4, character: 8 } },
            children: [
              {
                name: 'helper',
                kind: 6,
                range: { start: { line: 7, character: 1 }, end: { line: 9, character: 0 } },
                selectionRange: { start: { line: 7, character: 8 }, end: { line: 7, character: 14 } },
              },
            ],
          },
          {
            name: 'Widget',
            kind: 5,
            range: { start: { line: 15, character: 0 }, end: { line: 30, character: 0 } },
            selectionRange: { start: { line: 15, character: 6 }, end: { line: 15, character: 12 } },
          },
        ];
      }
      return null;
    },
    'lsp.symbols': () => [],
    // Карта символов в моке пуста: в браузере нет ни файлов проекта, ни языкового
    // сервера, который их разбирает. Пустой ответ — честное «ещё не собрана».
    'index.status': () => ({
      root: null,
      phase: 'idle',
      files: 0,
      decls: 0,
      dependencyFiles: 0,
      dependencyPackages: 0,
      skipped: 0,
    }),
    'index.find': () => [],
    'index.rebuild': () => ({
      root: null,
      phase: 'idle',
      files: 0,
      decls: 0,
      dependencyFiles: 0,
      dependencyPackages: 0,
      skipped: 0,
    }),
    'index.inherited': (params) => ({
      name: params?.name ?? '',
      declared: null,
      ancestors: [],
      members: [],
      phase: 'idle',
    }),
    // Ссылок и иерархии типов в моке нет: пустые ответы — как у сервера без них.
    // Триггеров у мока нет: попап в нём открывается только по своим словам.
    'lsp.capabilities': () => ({ triggerCharacters: [], allCommitCharacters: [], resolveProvider: false }),
    // Как main: «нашлись» только pylsp и typescript-language-server.
    'lsp.detect': () => [
      { language: 'python', command: 'pylsp', args: [], enabled: true },
      { language: 'typescript', command: 'typescript-language-server', args: ['--stdio'], enabled: true },
    ],
    // Настройки проекта из `.chui_ide`: в моке держим в памяти, как это делает main.
    'project.config': () => structuredClone(projectSettings),
    'project.updateSettings': (params) => {
      Object.assign(projectSettings, params.patch ?? {});
      return structuredClone(projectSettings);
    },
    // Карта проекта и окружения — заглушки: главное, чтобы методы отвечали.
    'project.scan': () => ({
      root: currentRoot ?? '',
      name: currentRoot ? currentRoot.split('/').pop() : '',
      fileCount: 0,
      dirCount: 0,
      languages: [],
      markers: [],
      kind: { id: 'unknown', label: 'Неизвестно', source: 'none' },
      testFiles: [],
      testDirs: [],
      entryPoints: [],
      topDirs: [],
    }),
    'python.environments': () => [],
    // Проверка импортов в моке ничего не находит: окружение не настоящее.
    'imports.missing': () => ({ missing: [] }),
    'python.packages': () => [],
    'python.install': () => ({ installed: [] }),
    'python.tests': () => ({ tests: [], total: 0, errors: [] }),
    'python.envHealth': () => [],
    'python.format': (params) => ({ text: params.text ?? '', tool: null }),
    // Интерпретаторов в моке нет: список пуст — как на системе без питона.
    'python.interpreters': () => [],
    // Файловой системы в моке нет: по любой папке отвечаем «окружения нет».
    'python.venvAt': () => ({
      environment: null,
      candidates: [],
      reason: 'В моке нет файловой системы',
    }),
    // Окружение Node в моке не настоящее: Node «не найден», пакетов нет. Этого
    // хватает, чтобы попап окружения и форматирование рисовались, а не падали.
    'node.info': () => ({
      runtime: { version: null, command: 'node', label: 'Node не найден' },
      packageManager: { name: 'npm', version: null },
    }),
    'node.packages': () => [],
    'node.envHealth': () => [],
    'node.format': (params) => ({ text: params.text ?? '', tool: null }),
    // Тестов Node в моке нет: список пуст и раннер не найден — панель скажет об этом.
    'node.tests': () => ({ runner: null, tests: [], total: 0, errors: [] }),
    // Проверка подключения: два понятных исхода вместо исключения.
    'ai.test': (params) => {
      if (/bad|invalid/i.test(params.baseUrl)) {
        return { ok: false, models: [], message: 'Адрес не найден — проверьте написание сервера' };
      }
      const provider = settings.ai.providers.find((item) => item.id === params.providerId);
      const needsKey = !provider || /^https:/.test(params.baseUrl);
      if (needsKey && !params.apiKey) {
        return { ok: false, models: [], message: 'Нужен API-ключ: без него провайдер отклонит запрос' };
      }
      const models = ['gpt-4o', 'gpt-4o-mini', 'gpt-4o-realtime'];
      return { ok: true, models, message: `Подключение работает · доступно моделей: ${models.length}` };
    },
    'ai.chats.load': (params) => savedChats.get(params.root) ?? { conversations: [] },
    'ai.chats.save': (params) => {
      savedChats.set(params.root, {
        conversations: params.conversations ?? [],
        ...(params.activeUid ? { activeUid: params.activeUid } : {}),
      });
    },
    // Команды проекта: мок отдаёт одну свою, чтобы меню композера было из чего собрать.
    // Настоящие лежат в `.chui/commands` проекта — читает их main (`ai/commands.ts`).
    'ai.commands': () => [
      {
        name: 'review',
        description: 'Проверить diff и предложить правки',
        prompt: 'Посмотри, что изменено в проекте, и предложи минимальные правки. $ARGUMENTS',
        path: '/mock/.chui/commands/review.md',
        scope: 'workspace',
      },
    ],
    // Расписание задач: в браузере нет часов, поэтому мок держит список в памяти
    // и отдаёт его же на save/remove — так окно можно смотреть целиком.
    'schedule.list': () => mockSchedules,
    'schedule.save': (params) => {
      const schedule = params.schedule;
      const index = mockSchedules.findIndex((item) => item.id === schedule.id && schedule.id);
      const saved = { ...schedule, id: schedule.id || 'mock-schedule-1', enabled: schedule.enabled !== false };
      if (index >= 0) mockSchedules[index] = saved;
      else mockSchedules.push(saved);
      return mockSchedules;
    },
    'schedule.remove': (params) => {
      mockSchedules = mockSchedules.filter((item) => item.id !== params.id);
      return mockSchedules;
    },
    'schedule.finish': () => mockSchedules,
    // Журнал прогонов: в браузере прогонов нет, поэтому мок отдаёт одну строку —
    // по ней видно окно целиком (список, подписи, кнопки подвала).
    'ai.telemetry': () => ({
      enabled: true,
      path: '/mock/userData/telemetry/runs.jsonl',
      bytes: 2048,
      records: [
        {
          version: 1,
          at: Date.now() - 60_000,
          startedAt: Date.now() - 61_200,
          provider: 'openai',
          model: 'gpt-4o-mini',
          mode: 'agent',
          permission: 'ask',
          finished: 'answer',
          ms: 1200,
          trace: { steps: 2, toolCalls: 1, usage: { promptTokens: 900, completionTokens: 120 } },
          system: { provider: 'openai', model: 'gpt-4o-mini', mode: 'agent', permission: 'ask', tools: 51 },
          steps: [],
        },
      ],
    }),
    'ai.telemetryClear': () => ({ ok: true }),
    // Inline-автодополнение: мок молча отдаёт короткую подсказку.
    'ai.complete': async () => ({ text: '// подсказка от мока' }),
    // Сообщение коммита: мок отвечает так, как это делает модель после очистки.
    'ai.commitMessage': async () => ({ message: 'Панель изменений: сообщение коммита по diff' }),
    // Название беседы: мок отвечает коротко и по делу — как модель после очистки.
    'ai.chatTitle': async () => ({ title: 'Мок: разговор о коде' }),
    // Тест к коду: мок отвечает так, как это делает модель после очистки.
    'ai.generateTest': async () => ({
      code: "describe('мок', () => {\n  it('работает', () => {\n    expect(true).toBe(true);\n  });\n});\n",
    }),
    // Живые агенты: в браузере подзадач нет, поэтому список пуст — панель просто
    // не появится. Вызовы правки отвечают «нет такого агента», как настоящие.
    'ai.agents': () => [],
    'ai.agentInterrupt': () => ({ ok: false }),
    'ai.agentMessage': () => ({ ok: false, reason: 'В браузере агентов нет' }),
    'ai.chat': async (params, id) => {
      cancelRequested = false;

      // Сжатие беседы — отдельный короткий запрос: модель отвечает резюме,
      // а не обычным ответом с размышлениями и блоками кода.
      const asked = params.messages.at(-1)?.content ?? '';
      if (/Сожми нашу беседу/.test(asked)) {
        await sleep(60);
        const summary = 'Просили разобрать панель; правили package.json; раскладка ассистента проверена.';
        emit(id, 'delta', { text: summary });
        return {
          text: summary,
          finishReason: 'stop',
          usage: { promptTokens: 9, completionTokens: 12 },
          run: mockRun(false),
        };
      }

      // Размышления reasoning-моделей приходят отдельным полем — показываем их блоком.
      const thoughts = 'Сначала посмотрю на открытый файл. Потом отвечу коротко и по делу.';
      if (FAST) emit(id, 'reasoning', { text: thoughts });
      else {
        for (const word of thoughts.split(' ')) {
          await sleep(14);
          if (cancelRequested) break;
          emit(id, 'reasoning', { text: `${word} ` });
        }
      }

      // Как настоящий агент: сначала план, потом разрешение на команду, потом правка файла.
      if (params.useTools) {
        emit(id, 'plan', {
          steps: [
            { text: 'Изучить панель ассистента', status: 'done' },
            { text: 'Проверить команду линтера', status: 'in_progress' },
            { text: 'Применить правку package.json', status: 'pending' },
          ],
        });

        // Пачка чтения проекта: в жизни агент смотрит десяток папок подряд,
        // такие вызовы должны свернуться в одну строку, а не залить весь чат.
        const folders = ['src', 'src/main', 'src/renderer', 'scripts'];
        for (const [index, folder] of folders.entries()) {
          const dirId = `mock-dir-${index}`;
          emit(id, 'tool_start', { id: dirId, name: 'list_dir', args: JSON.stringify({ path: `${ROOT}/${folder}` }) });
          await sleep(50);
          emit(id, 'tool_result', {
            id: dirId,
            name: 'list_dir',
            ok: true,
            summary: 'элементов: 6',
            detail: ['index.ts', 'service.ts', 'tools.ts', 'main.css', 'chat.ts', 'package.json']
              .map((name) => `- ${name}`)
              .join('\n'),
          });
        }

        const command = 'npm run lint';
        emit(id, 'tool_start', {
          id: 'mock-call-0',
          name: 'run_terminal',
          args: JSON.stringify({ command }),
        });
        const permission = await askHost('ai.confirmCommand', { command });
        emit(id, 'tool_result', {
          id: 'mock-call-0',
          name: 'run_terminal',
          ok: Boolean(permission?.allowed),
          summary: permission?.allowed ? 'код выхода 0' : 'Пользователь запретил выполнение команды',
          detail: permission?.allowed ? `$ ${command}\n(мок: команда не выполняется)` : undefined,
        });

        const callId = 'mock-call-1';
        const target = `${ROOT}/package.json`;
        const edits = [
          {
            path: target,
            edits: [
              {
                startLine: 1,
                startColumn: 1,
                endLine: 1,
                endColumn: 1,
                newText: '// Правка агента\n// вторая строка\n// третья строка\n',
              },
            ],
          },
        ];

        emit(id, 'tool_start', { id: callId, name: 'apply_edit', args: JSON.stringify({ edits }) });
        const decision = await askHost('ai.applyEdits', { edits });
        const ok = !decision?.rejected;
        emit(id, 'tool_result', {
          id: callId,
          name: 'apply_edit',
          ok,
          summary: ok ? 'применено файлов: 1' : 'Пользователь отклонил правки',
        });
      }

      // Ответ с несколькими блоками: на нём видно, что подсветка включается
      // для каждого языка по метке в ограде, а не только для `js`.
      const answer =
        'Проверка панели: ответ приходит потоком.\n' +
        '```js\nconst answer = 42;\n```\n' +
        '```diff\n- старый вызов модели\n+ новый вызов с планом\n```\n' +
        '| Часть | Состояние |\n| --- | --- |\n| Лента | обновлена |\n| Композер | без изменений |\n' +
        '- [x] собрал проект\n- [ ] проверил в браузере\n' +
        '```python\ndef greet(name: str) -> str:\n    return f"привет, {name}"\n```\n' +
        '```bash\nnpm run smoke:agent\n```\n' +
        'Инлайн-код: `view.toggleRight` и `layout.setRightVisible(...)`.\n' +
        `Файл — ${params.messages.at(-1)?.content ?? ''}.`;
      // В быстром режиме ответ уходит одной порцией: браузер режет таймеры скрытой
      // вкладки до секунды, и поток по словам длился бы минуты.
      if (FAST) {
        emit(id, 'delta', { text: answer });
        return {
          text: answer,
          finishReason: 'stop',
          usage: { promptTokens: 12, completionTokens: 24 },
          run: mockRun(Boolean(params.useTools)),
        };
      }

      let text = '';
      for (const word of answer.split(' ')) {
        await sleep(18);
        if (cancelRequested) {
          const stopped = new Error('Операция отменена');
          stopped.code = -32800; // RpcErrorCode.Cancelled
          throw stopped;
        }
        text += `${word} `;
        emit(id, 'delta', { text: `${word} ` });
      }
      return {
        text,
        finishReason: 'stop',
        usage: { promptTokens: 12, completionTokens: 24 },
        run: mockRun(Boolean(params.useTools)),
      };
    },
  };

  /**
   * Трасса прогона для мока. Настоящую собирает main (он один знает системные
   * сообщения и состав инструментов), поэтому здесь — правдоподобный образец:
   * два шага, повтор чтения, вызов команды и время у каждого.
   */
  const mockRun = (usedTools) => {
    const steps = usedTools
      ? [
          {
            index: 1,
            ms: 2400,
            reasoning: 'Сначала посмотрю на файлы проекта, потом проверю линтер.',
            calls: [
              {
                id: 'mock-dir-0',
                name: 'list_dir',
                args: JSON.stringify({ path: `${ROOT}/src` }),
                ok: true,
                summary: 'элементов: 6',
                ms: 12,
              },
              {
                id: 'mock-call-0',
                name: 'run_terminal',
                args: JSON.stringify({ command: 'npm run lint' }),
                ok: true,
                summary: 'код выхода 0',
                ms: 1840,
              },
            ],
          },
          {
            index: 2,
            ms: 1500,
            text: 'Проверка панели: ответ приходит потоком.',
            calls: [
              {
                id: 'mock-call-1',
                name: 'read_file',
                args: JSON.stringify({ path: `${ROOT}/src/main/ai/service.ts` }),
                ok: true,
                summary: 'строки 1–40 уже прочитаны',
                note: 'диапазон уже прочитан',
              },
            ],
          },
        ]
      : [{ index: 1, ms: 1200, text: 'Ответ без инструментов.', calls: [] }];
    const calls = steps.reduce((sum, step) => sum + step.calls.length, 0);
    return {
      startedAt: Date.now() - 4000,
      ms: 4000,
      steps,
      system: {
        instructions: 'Ты — встроенный ассистент chui_iDE. Отвечай кратко и по делу.',
        context: 'Проект: chui-ide (Node.js, TypeScript). Тесты: vitest, каталог tests.',
        attachments: ['file: src/renderer/ui/chat.ts'],
        provider: 'openai',
        model: 'gpt-4o-mini',
        mode: usedTools ? 'agent' : 'question',
        permission: 'ask',
        tools: usedTools ? 24 : 0,
        toolsTokens: usedTools ? 4200 : 0,
      },
      finished: 'answer',
      trace: { steps: steps.length, toolCalls: calls, usage: { promptTokens: 12, completionTokens: 24 } },
    };
  };

  /** Разбор имени метода: ищем точное совпадение, иначе ошибка контракта. */
  const dispatch = async (call) => {
    const handler = methods[call.method];
    if (!handler) {
      const error = new Error(`нет мока для ${call.method}`);
      error.code = -32601;
      throw error;
    }
    return handler(call.params ?? {}, call.id);
  };

  window.chui = {
    platform: 'linux',
    versions: { electron: '44.7.0-mock', chrome: '152.0.0-mock', node: '24.0.0-mock' },
    async call(call) {
      try {
        return { id: call.id, ok: true, value: await dispatch(call) };
      } catch (error) {
        return {
          id: call.id,
          ok: false,
          error: { code: error.code ?? -32603, message: String(error.message ?? error) },
        };
      }
    },
    async cancel() {
      cancelRequested = true;
      return true;
    },
    onRpcEvent(listener) {
      rpcEventListeners.add(listener);
      return (listenerId += 1);
    },
    onPush(listener) {
      pushListeners.add(listener);
      return (listenerId += 1);
    },
    onHostRequest(listener) {
      hostListeners.add(listener);
      return (listenerId += 1);
    },
    async replyHostRequest(reply) {
      const resolve = pendingHost.get(reply.id);
      if (!resolve) return false;
      pendingHost.delete(reply.id);
      resolve(reply.ok ? reply.value : { rejected: true });
      return true;
    },
    off() {
      // В моке подписчики живут до перезагрузки страницы — отписываться не от чего.
    },
  };
})();
