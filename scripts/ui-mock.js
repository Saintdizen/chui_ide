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
 * Правки контракта нужно переносить сюда: мок отвечает за все ключи `ChuiMethods`,
 * иначе проверка покажет ошибку вызова, а не ошибку интерфейса.
 */
(() => {
  const ROOT = '/mock/project';
  const MOCK_SHELL = '/bin/bash';

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
  ]);

  const DIRS = new Map([
    [`${ROOT}`, ['.gitverse', 'app', 'docs', 'scripts', 'src', 'eslint.config.js', 'package.json', 'README.md']],
    [`${ROOT}/.gitverse`, ['config.json', 'logo.svg']],
    [`${ROOT}/app`, ['main.js', 'window.js', 'index.html']],
    [`${ROOT}/docs`, ['architecture.md', 'roadmap.md']],
    [`${ROOT}/scripts`, ['build.mjs', 'dev.mjs']],
    [`${ROOT}/src`, ['queue.js', 'logger.js']],
  ]);

  const kindOf = (path) => (DIRS.has(path) ? 'directory' : 'file');
  const entriesOf = (path) =>
    (DIRS.get(path) ?? []).map((name) => {
      const child = `${path === '/' ? '' : path}/${name}`;
      const size = FILES.get(child)?.length ?? 0;
      return { name, path: child, kind: kindOf(child), size };
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
      { path: `${ROOT}/eslint.config.js`, relative: 'eslint.config.js', change: 'modified', staged: false, unstaged: true },
      { path: `${ROOT}/README.md`, relative: 'README.md', change: 'untracked', staged: false, unstaged: true },
      { path: `${ROOT}/src/queue.js`, relative: 'src/queue.js', change: 'deleted', staged: false, unstaged: true },
    ],
  };

  const gitBranches = [    { name: 'main', current: true, remote: false },
    { name: 'feat/git', current: false, remote: false },
    { name: 'origin/main', current: false, remote: true },
  ];

  const fileText = (rel) => FILES.get(`${ROOT}/${rel}`) ?? '';

  const gitStatus = () => ({ repository: { ...gitState.repository }, files: gitState.files.map((file) => ({ ...file })) });

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

  let currentRoot = null;
  const recent = [
    { path: ROOT, name: 'project', exists: true },
    { path: '/mock/gone-project', name: 'gone-project', exists: false },
  ];

  /* ── настройки: те же ключи, что в `main/settings.ts` ──────────────────── */

  const settings = {
    ai: {
      providers: [
        {
          id: 'openai',
          label: 'OpenAI',
          baseUrl: 'https://api.openai.com/v1',
          models: ['gpt-4o-mini', 'gpt-4o'],
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
      systemPrompt: 'Ты ассистент внутри редактора.',
    },
    editor: { tabSize: 2, fontSize: 14, wordWrap: false, minimap: false },
    // «Системная» — чтобы схему в проверке задавал Playwright (`emulateMedia`).
    appearance: { theme: 'system' },
  };

  /* ── шина: события вызова и широковещательные push-сообщения ───────────── */

  const rpcEventListeners = new Set();
  const pushListeners = new Set();
  let listenerId = 0;

  const emit = (id, event, payload) => {
    for (const listener of rpcEventListeners) listener({ id, event, payload });
  };
  const push = (topic, payload) => {
    for (const listener of pushListeners) listener({ topic, payload });
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /* ── методы ───────────────────────────────────────────────────────────── */

  const sessions = new Map();
  let bounds = { x: 40, y: 40, width: 1280, height: 820 };

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

    'git.status': () => gitStatus(),
    'git.init': () => gitChanged(),
    'git.stage': (params) => setStaged(params.paths, true),
    'git.unstage': (params) => setStaged(params.paths, false),
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
      return { original, modified: text };
    },
    'git.branches': () => gitBranches.map((branch) => ({ ...branch })),
    'git.checkout': (params) => {
      gitState.repository.branch = params.name;
      for (const branch of gitBranches) branch.current = branch.name === params.name;
      return gitChanged();
    },

    'workspace.current': () => ({ root: currentRoot }),

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
    'workspace.readFile': (params) => ({
      text: FILES.get(params.path) ?? '',
      mtimeMs: Date.now(),
    }),
    'workspace.writeFile': (params) => {
      FILES.set(params.path, params.text ?? '');
      return { mtimeMs: Date.now() };
    },
    'workspace.stat': (params) => ({
      path: params.path,
      kind: kindOf(params.path),
      size: FILES.get(params.path)?.length ?? 0,
      mtimeMs: Date.now(),
    }),
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
    'workspace.createFile': (params) => {
      FILES.set(params.path, '');
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
    'terminal.list': () => [...sessions.values()],

    'window.getState': () => ({ maximized: false, fullScreen: false, platform: 'linux', customControls: true }),
    'window.minimize': () => undefined,
    'window.toggleMaximize': () => {
      bounds = { ...bounds, y: 0, height: 900 };
      const state = { maximized: true, fullScreen: false, platform: 'linux', customControls: true };
      push('window:state', state);
      return state;
    },
    'window.close': () => undefined,
    'window.getBounds': () => ({ ...bounds }),
    'window.setBounds': (params) => {
      bounds = { ...bounds, ...params };
      return { ...bounds };
    },
    'app.showMenu': () => undefined,

    'settings.get': () => structuredClone(settings),
    'settings.update': (params) => {
      Object.assign(settings.ai, params.ai ?? {});
      Object.assign(settings.editor, params.editor ?? {});
      Object.assign(settings.appearance, params.appearance ?? {});
      const snapshot = structuredClone(settings);
      push('settings:changed', snapshot);
      return snapshot;
    },
    'settings.revealFile': () => ({ path: '/mock/config/settings.json' }),

    'ai.setApiKey': () => structuredClone(settings),
    'ai.clearApiKey': () => structuredClone(settings),
    'ai.models': () => settings.ai.providers[0].models,
    'ai.chat': async (params, id) => {
      const answer = `Проверка панели: ответ приходит потоком. Файл — ${params.messages.at(-1)?.content ?? ''}.`;
      let text = '';
      for (const word of answer.split(' ')) {
        await sleep(18);
        text += `${word} `;
        emit(id, 'delta', { text: `${word} ` });
      }
      return { text, finishReason: 'stop', usage: { promptTokens: 12, completionTokens: 24 } };
    },
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
    off() {
      // В моке подписчики живут до перезагрузки страницы — отписываться не от чего.
    },
  };
})();
