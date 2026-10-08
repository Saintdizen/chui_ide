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
      systemPrompt: 'Ты ассистент внутри редактора.',
    },
    editor: {
      tabSize: 2,
      fontSize: 14,
      wordWrap: false,
      minimap: false,
      fontLigatures: true,
      insertSpaces: true,
      languageIndent: true,
      renderWhitespace: 'selection',
      cursorBlinking: 'smooth',
      smoothScrolling: true,
      scrollBeyondLastLine: true,
      lineNumbers: 'on',
      renderLineHighlight: 'all',
      bracketPairColorization: true,
      stickyScroll: false,
      quickSuggestions: true,
      showUnused: true,
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
      openOnSingleClick: false,
      confirmDelete: true,
      exclude: [],
    },
    run: { pythonPath: '', packageManager: 'auto', saveBeforeRun: true },
    // «Системная» — чтобы схему в проверке задавал Playwright (`emulateMedia`).
    appearance: { theme: 'system' },
    // Усилие размышления: по умолчанию не отправляется (см. shared/providers.ts).
    reasoningEffort: 'off',
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

    // Картинку отдаём настоящую (крошечный PNG): по ней видно, что миниатюра
    // в чипе действительно рисуется, а не только имя файла.
    'dialog.pickImages': () => [
      { name: 'screenshot.png', mime: 'image/png', bytes: 68, dataUrl: TINY_PNG },
    ],

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
    'menu.role': () => undefined,

    'settings.get': () => structuredClone(settings),
    'settings.update': (params) => {
      const { provider, removeProviderId, ...ai } = params.ai ?? {};
      Object.assign(settings.ai, ai);
      Object.assign(settings.editor, params.editor ?? {});
      Object.assign(settings.explorer, params.explorer ?? {});
      Object.assign(settings.run, params.run ?? {});
      Object.assign(settings.appearance, params.appearance ?? {});

      // Провайдеров добавляем и убираем так же, как это делает SettingsStore.
      if (provider) {
        const existing = settings.ai.providers.find((item) => item.id === provider.id);
        if (existing) Object.assign(existing, provider);
        else settings.ai.providers.push({ models: [], ...provider });
      }
      if (removeProviderId) {
        settings.ai.providers = settings.ai.providers.filter((item) => item.id !== removeProviderId);
      }

      // Схему main сообщает push-событием: от неё зависят Monaco, xterm и
      // подсветка кода в чате, поэтому мок обязан её отдавать так же.
      if (params.appearance?.theme) {
        const chosen = settings.appearance.theme;
        const scheme = chosen === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : chosen;
        push('theme:changed', { theme: chosen, scheme });
      }

      const snapshot = structuredClone(settings);
      push('settings:changed', snapshot);
      return snapshot;
    },
    'settings.revealFile': () => ({ path: '/mock/config/settings.json' }),

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
    'ai.models': () => settings.ai.providers[0].models,
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
    'ai.chat': async (params, id) => {
      cancelRequested = false;

      // Сжатие беседы — отдельный короткий запрос: модель отвечает резюме,
      // а не обычным ответом с размышлениями и блоками кода.
      const asked = params.messages.at(-1)?.content ?? '';
      if (/Сожми нашу беседу/.test(asked)) {
        await sleep(60);
        const summary = 'Просили разобрать панель; правили package.json; раскладка ассистента проверена.';
        emit(id, 'delta', { text: summary });
        return { text: summary, finishReason: 'stop', usage: { promptTokens: 9, completionTokens: 12 } };
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

      // Как настоящий агент: сначала спрашивает разрешение на команду, потом правит файл.
      if (params.useTools) {
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
        '```python\ndef greet(name: str) -> str:\n    return f"привет, {name}"\n```\n' +
        '```bash\nnpm run smoke:agent\n```\n' +
        `Файл — ${params.messages.at(-1)?.content ?? ''}.`;
      // В быстром режиме ответ уходит одной порцией: браузер режет таймеры скрытой
      // вкладки до секунды, и поток по словам длился бы минуты.
      if (FAST) {
        emit(id, 'delta', { text: answer });
        return { text: answer, finishReason: 'stop', usage: { promptTokens: 12, completionTokens: 24 } };
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
