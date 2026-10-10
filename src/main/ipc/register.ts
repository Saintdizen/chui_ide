import { app, BrowserWindow, dialog, shell } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  CloneEvent,
  MAX_CHAT_IMAGES,
  PushTopic,
  RpcErrorCode,
  VenvEvent,
  type AppInfo,
  type ChatRequest,
  type ParamsOf,
  type PickedImage,
  type RecentProject,
  type SettingsPatch,
  type WindowBounds,
} from '../../shared/api';
import type { AiService } from '../ai/service';
import { ChatStore } from '../ai/chat-store';
import { IMAGE_EXTENSIONS, readImageAsDataUrl } from '../ai/images';
import type { GitService } from '../git/git';
import type { DebugService } from '../debug/debug';
import type { LspService } from '../lsp/lsp';
import type { McpService } from '../mcp/mcp';
import { performMenuRole } from '../menu';
import type { SettingsStore } from '../settings';
import { detectAvailableCommands, detectVenvCommands } from '../lsp/detect';
import { scanProject } from '../project/scan';
import { activateCommand, createVenv, findEnvironments, pythonInterpreterFor } from '../python/environments';
import { missingPackages } from '../node/packages';
import {
  checkEnvironment as checkNodeEnvironment,
  nodeInfo,
  installedPackages as installedNodePackages,
} from '../node/environment';
import { formatNode } from '../node/format';
import { collectNodeTests } from '../node/tests';
import { missingModules } from '../python/packages';
import { findInterpreters } from '../python/interpreters';
import { installPackages, installedPackages } from '../python/pip';
import { collectTests } from '../python/tests';
import { formatPython } from '../python/format';
import { checkEnvironments } from '../python/health';
import type { SessionStore } from '../session-store';
import type { ProjectConfigStore } from '../project-config';
import { matchPresets } from '../../shared/lsp-presets';
import { unsavedClosePrompt } from '../../shared/unsaved';
import type { TerminalService } from '../terminal/terminal';
import { applyBounds, openIdeWindow, windowState } from '../window';
import type { WorkspaceService } from '../workspace/workspace';
import type { HostClient } from './host';
import { pushToRenderers } from './push';
import { RpcFailure, RpcRouter, type RpcContext } from './router';

export interface AppDependencies {
  settings: SettingsStore;
  workspace: WorkspaceService;
  ai: AiService;
  terminals: TerminalService;
  git: GitService;
  /** Обратные вызовы main → renderer (правки в документной модели). */
  host: HostClient;
  /** Хранилище бесед. Необязательно: пробникам история чата не нужна. */
  chatStore?: ChatStore;
  /** Языковые серверы. Необязательно: пробникам LSP не нужен. */
  lsp?: LspService;
  /** Внешние инструменты (MCP). Необязательно: без серверов их и нет. */
  mcp?: McpService;
  /** Отладчик (DAP). Необязательно: пробникам он не нужен. */
  debug?: DebugService;
  /** Сессия проекта (вкладки, папки, панели). Необязательно для пробников. */
  sessions?: SessionStore;
  /** Настройки уровня проекта: `<root>/.chui_ide/` (см. ProjectConfigStore). */
  projectConfig?: ProjectConfigStore;
}

/**
 * Связываем сервисы с контрактом RPC. Компилятор следит за тем, чтобы
 * аргументы и результат каждого метода совпадали с shared/api.ts.
 */
/**
 * Открыть папку как проект: запомнить её, поднять окно IDE, обновить git.
 *
 * Один путь на все входы: стартовое окно, путь в командной строке, `open-file`
 * на macOS и второй запуск приложения. Разные пути означали бы, что проект,
 * открытый из терминала, чем-то отличается от открытого из стартового окна —
 * например, не попадает в историю или не обновляет состояние git.
 */
export async function openProjectFolder(
  deps: AppDependencies,
  folder: string,
): Promise<{ root: string; name: string }> {
  const info = await deps.workspace.open(folder);
  deps.settings.rememberProject(info.root);
  openIdeWindow();
  await deps.git.refresh();
  return { root: info.root, name: info.name };
}

export function registerIpc(deps: AppDependencies): RpcRouter {
  const router = new RpcRouter();

  // Любая правка в рабочей папке — это потенциальная правка в репозитории.
  // Обновляем статус сразу, а результат отдаём push-событием.
  const refreshGit = (): void => {
    void deps.git.refresh().catch(() => undefined);
  };

  // Git нужен и агенту (инструменты git_status/git_diff) — отдаём ему тот же сервис.
  deps.ai.attachGit(deps.git);
  // Терминалы — тоже: агент работает с pty-сессиями, а не только разовыми командами.
  deps.ai.attachTerminals(deps.terminals);
  // Языковой сервер умеет искать по символам («перейти к символу») — это и есть
  // инструмент codebase_search. Нет сервера — инструмент модели не предлагаем.
  if (deps.lsp) deps.ai.attachSymbols(deps.lsp);
  // Внешние инструменты (MCP): список ведут серверы из настроек, а запускает их
  // этот сервис — агент получает готовые вызовы.
  if (deps.mcp) deps.ai.attachMcp(deps.mcp);

  router.register(
    'app.info',
    (): AppInfo => ({
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
    }),
  );

  router.register('dialog.pickFolder', async (params: ParamsOf<'dialog.pickFolder'>) => {
    const result = await dialog.showOpenDialog({
      title: params.title ?? 'Открыть папку',
      properties: ['openDirectory', 'createDirectory'],
    });
    return { path: result.canceled ? null : (result.filePaths[0] ?? null) };
  });

  // Картинки читает main: renderer файловой системы не видит, и получать доступ
  // к ней ради вложения в чат ему незачем. Файлы отдаём сразу data-URL —
  // в таком виде их понимает и <img> в интерфейсе, и OpenAI-совместимый API.
  router.register('dialog.pickImages', async (_params, ctx) => {
    const result = await dialog.showOpenDialog(senderWindow(ctx), {
      title: 'Приложить изображение',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Изображения', extensions: IMAGE_EXTENSIONS }],
    });
    if (result.canceled) return [];

    const picked: PickedImage[] = [];
    for (const file of result.filePaths.slice(0, MAX_CHAT_IMAGES)) {
      const image = await readImageAsDataUrl(file).catch(() => null);
      if (image) picked.push(image);
    }
    return picked;
  });

  // Подтверждение спрашиваем системным диалогом: он модальный для окна
  // и не даёт случайно подтвердить разрушительное действие вводом с клавиатуры.
  router.register('dialog.confirm', async (params, ctx) => {
    const { response } = await dialog.showMessageBox(senderWindow(ctx), {
      type: 'warning',
      title: params.title,
      message: params.message,
      detail: params.detail,
      buttons: [params.confirmLabel ?? 'Продолжить', 'Отмена'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    return { confirmed: response === 0 };
  });

  // Закрытие окна с несохранёнными файлами. Диалог системный и модальный: тут
  // нужен выбор из трёх исходов, и «Сохранить» — единственный путь без потерь.
  router.register('dialog.confirmClose', async (params, ctx) => {
    const prompt = unsavedClosePrompt(params.files);
    const { response } = await dialog.showMessageBox(senderWindow(ctx), {
      type: 'warning',
      title: 'Несохранённые файлы',
      message: prompt.message,
      detail: prompt.detail,
      buttons: ['Сохранить', 'Выйти без сохранения', 'Отмена'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    const choice: 'save' | 'discard' | 'cancel' = response === 0 ? 'save' : response === 1 ? 'discard' : 'cancel';
    return { choice };
  });

  router.register('workspace.readDir', (params) => deps.workspace.readDir(params.path));
  router.register('workspace.readFile', (params) => deps.workspace.readFile(params.path));
  router.register('workspace.writeFile', async (params) => {
    const result = await deps.workspace.writeFile(params.path, params.text);
    refreshGit();
    return result;
  });
  router.register('workspace.stat', (params) => deps.workspace.stat(params.path));
  router.register('workspace.search', (params) => deps.workspace.search(params));
  router.register('workspace.listFiles', () => deps.workspace.listFiles());
  router.register('workspace.replace', async (params) => {
    const result = await deps.workspace.replace(params);
    // Замена дописала файлы на диске — обновляем и git-статус.
    refreshGit();
    return result;
  });
  router.register('workspace.createFile', async (params) => {
    const path = await deps.workspace.createFile(params.path);
    refreshGit();
    return { path };
  });
  router.register('workspace.createDir', async (params) => {
    const path = await deps.workspace.createDir(params.path);
    refreshGit();
    return { path };
  });
  router.register('workspace.rename', async (params) => {
    const path = await deps.workspace.rename(params.from, params.to);
    refreshGit();
    return { path };
  });
  router.register('workspace.trash', async (params) => {
    await deps.workspace.trash(params.path);
    refreshGit();
  });

  // Открытие рабочей папки меняет состояние репозитория целиком, поэтому
  // обновляем его сразу и рассылаем — UI не должен ходить за этим сам.
  router.register('workspace.open', async (params) => {
    const info = await deps.workspace.open(params.path);
    // Открытая папка попадает в историю стартового окна.
    deps.settings.rememberProject(info.root);
    await deps.git.refresh();
    return info;
  });

  router.register('workspace.current', () => ({ root: deps.workspace.rootPath() }));

  /** Корень проекта нужен методам, читающим файлы: без него им нечего сканировать. */
  const requireRoot = (): string => {
    const root = deps.workspace.rootPath();
    if (!root) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Рабочая папка не открыта');
    return root;
  };

  /**
   * Интерпретатор для проверок: путь из настроек, иначе окружение проекта,
   * а в крайнем случае — системный. Тем же путём его выбирает и запуск кода:
   * проверять импорты чужим питоном значило бы врать про окружение.
   */
  const resolvePython = (root: string | null): string => {
    const run = deps.settings.get().run;
    // Интерпретатор, выбранный для конкретного проекта, важнее общего: два
    // Python-проекта не должны подменять друг другу окружение.
    const perProject = (root ? run.pythonByRoot[root] : undefined)?.trim() ?? '';
    const configured = perProject || run.pythonPath;
    const byPath = pythonInterpreterFor(root, configured);
    if (byPath) return byPath;
    const bare = configured.trim();
    if (bare) return bare;
    return process.platform === 'win32' ? 'python' : 'python3';
  };

  // Карта проекта: обход имён без чтения содержимого, поэтому можно звать часто.
  router.register('project.scan', async () => scanProject(requireRoot()));

  /* ── Python: виртуальные окружения проекта ─────────────────────────────── */

  // Главное окружение идёт первым — на него ориентируются запуск, тесты и подсказки.
  router.register('python.environments', () => findEnvironments(requireRoot(), process.platform));

  // Установленные в системе интерпретаторы: их выбор нужен при создании окружения.
  router.register('python.interpreters', () => findInterpreters(process.platform));

  // Создание долгое: шаги и вывод команд уезжают событиями, как у `git.clone`.
  router.register('python.createVenv', (params, ctx) =>
    createVenv(requireRoot(), params, (payload) => ctx.emit(VenvEvent.Progress, payload), ctx.signal),
  );

  router.register('python.activateCommand', async () => {
    const root = requireRoot();
    const environments = await findEnvironments(root, process.platform);
    const primary = environments.find((environment) => environment.primary);
    return { command: primary ? activateCommand(root, primary.path, process.platform) : null };
  });

  // Проверка импортов: какие модули файл подключает, а проект их не видит.
  // У Python окружение — интерпретатор, у JS/TS — каталоги `node_modules`.
  router.register('imports.missing', async (params) => {
    const root = deps.workspace.rootPath();
    const missing =
      params.language === 'python'
        ? await missingModules(root, resolvePython(root), params.modules)
        : await missingPackages(root, params.modules);
    return { missing };
  });

  // Установленные пакеты главного окружения: имя и версия.
  router.register('python.packages', () =>
    installedPackages(resolvePython(deps.workspace.rootPath()), deps.workspace.rootPath() ?? undefined),
  );

  // Установка долгая: шаги и вывод pip уезжают событиями, как при создании окружения.
  router.register('python.install', (params, ctx) => {
    const root = requireRoot();
    return installPackages(
      root,
      resolvePython(root),
      params,
      (payload) => ctx.emit(VenvEvent.Progress, payload),
      ctx.signal,
    );
  });

  // Список тестов проекта: сбор без выполнения самих тестов.
  router.register('python.tests', () => {
    const root = requireRoot();
    return collectTests(root, resolvePython(root));
  });

  // Здоровье окружений: читаем `pyvenv.cfg` и смотрим, на месте ли базовый питон и pip.
  router.register('python.envHealth', () => checkEnvironments(requireRoot(), process.platform));

  // Форматирование: текст приходит из renderer и туда же уходит результат —
  // правку проводит документ, чтобы работали undo и сохранение.
  router.register('python.format', (params) => {
    const root = requireRoot();
    return formatPython(root, resolvePython(root), params.path, params.text);
  });

  /* ── Node: окружение проекта ───────────────────────────────────────────── */

  // Версия Node и менеджер пакетов: чем запускается код и чем ставить зависимости.
  router.register('node.info', () => nodeInfo(deps.workspace.rootPath()));

  // Установленные пакеты: то, что лежит в `node_modules` проекта.
  router.register('node.packages', () => installedNodePackages(requireRoot()));

  // Здоровье окружения: нет `node_modules`, не хватает зависимостей, версия Node
  // не под `engines.node`, нет файла блокировки.
  router.register('node.envHealth', () => checkNodeEnvironment(requireRoot()));

  // Форматирование файла инструментом проекта. Уговор тот же, что у `python.format`:
  // текст приходит из renderer и туда же уходит результат, правку проводит документ.
  router.register('node.format', (params) => formatNode(requireRoot(), params.path, params.text));

  // Список тестов проекта: у vitest — с именами, у jest и `node --test` — файлами.
  router.register('node.tests', () => collectNodeTests(requireRoot()));

  // Сессия проекта: renderer собирает состояние и кладёт сюда, а при следующем
  // открытии забирает обратно. Без хранилища (пробники) отвечаем пустой сессией.
  router.register('session.load', (params) => deps.sessions?.load(params.root) ?? { tabs: [], expanded: [] });
  router.register('session.save', (params) => {
    deps.sessions?.save(params.root, params.state);
  });
  // Настройки уровня проекта — в `<root>/.chui_ide/`. Свои для каждого проекта,
  // поэтому корень берём из параметров, а не из глобальных настроек. Макет
  // рабочей области сюда не входит: он общий и живёт в settings.json (userData).
  router.register('project.config', (params) => deps.projectConfig?.load(params.root) ?? {});
  router.register(
    'project.updateSettings',
    (params) => deps.projectConfig?.updateSettings(params.root, params.patch) ?? {},
  );
  /* ── стартовое окно ────────────────────────────────────────────────────── */

  /** Недавние проекты с проверкой, что папка ещё на месте. */
  const recentProjects = async (): Promise<RecentProject[]> => {
    const recent = deps.settings.get().workspace.recent;
    return Promise.all(
      recent.map(async (root) => ({
        path: root,
        name: path.basename(root) || root,
        exists: await fs
          .stat(root)
          .then((stat) => stat.isDirectory())
          .catch(() => false),
      })),
    );
  };

  router.register('app.recentProjects', recentProjects);

  router.register('app.forgetProject', (params) => {
    deps.settings.forgetProject(params.path);
    return recentProjects();
  });

  // Переход из стартового окна в IDE — тот же путь, что у запуска из командной
  // строки. Стартовое окно закрывает сам лаунчер, получив ответ: закрытие здесь
  // уничтожило бы окно раньше отправки ответа, и вызов остался бы без результата.
  router.register('app.openProject', (params) => openProjectFolder(deps, params.path));

  router.register('git.status', () => deps.git.status());
  router.register('git.init', () => deps.git.init());
  router.register('git.stage', (params) => deps.git.stage(params.paths));
  router.register('git.unstage', (params) => deps.git.unstage(params.paths));
  router.register('git.discard', (params) => deps.git.discard(params.paths));
  router.register('git.commit', (params) => deps.git.commit(params.message, params.paths));
  router.register('git.diff', (params) => deps.git.diff(params.path, params.staged));
  router.register('git.branches', () => deps.git.branches());
  router.register('git.checkout', (params) => deps.git.checkout(params.name, params.create));

  router.register('git.clone', (params, ctx) =>
    deps.git.clone(params.url, params.directory, (line) => ctx.emit(CloneEvent.Progress, { line })),
  );

  router.register('terminal.create', async (params) => deps.terminals.create(params));
  router.register('terminal.write', (params) => {
    deps.terminals.write(params.id, params.data);
  });
  router.register('terminal.resize', (params) => {
    deps.terminals.resize(params.id, params.cols, params.rows);
  });
  router.register('terminal.kill', (params) => {
    deps.terminals.kill(params.id);
  });

  // Окно ищем по отправителю запроса, а не по «текущему»: у приложения может
  // быть несколько окон, и управлять должно то, из которого пришёл вызов.
  const senderWindow = (ctx: RpcContext): BrowserWindow => {
    const window = BrowserWindow.fromWebContents(ctx.sender);
    if (!window) throw new RpcFailure(RpcErrorCode.NotFound, 'Окно не найдено');
    return window;
  };

  router.register('window.getState', (_params, ctx) => windowState(senderWindow(ctx)));
  router.register('window.minimize', (_params, ctx) => {
    senderWindow(ctx).minimize();
  });
  router.register('window.toggleMaximize', (_params, ctx) => {
    const window = senderWindow(ctx);
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    return windowState(window);
  });
  router.register('window.close', (_params, ctx) => {
    senderWindow(ctx).close();
  });
  router.register('window.getBounds', (_params, ctx) => senderWindow(ctx).getBounds());
  router.register('window.setBounds', (params: Partial<WindowBounds>, ctx) => applyBounds(senderWindow(ctx), params));
  router.register('menu.role', (params, ctx) => {
    performMenuRole(senderWindow(ctx).webContents, params.role);
  });

  router.register('settings.get', () => deps.settings.get());
  router.register('settings.update', (patch: SettingsPatch) => deps.settings.update(patch));
  router.register('settings.revealFile', async () => {
    const file = deps.settings.file();
    await shell.openPath(file).catch(() => undefined);
    return { path: file };
  });

  // Языковые серверы: renderer синхронизирует документ и просит перезапуск.
  router.register('lsp.open', async (params) => {
    await deps.lsp?.open(params.path, params.languageId, params.text);
  });
  router.register('lsp.change', (params) => {
    deps.lsp?.change(params.path, params.text);
  });
  router.register('lsp.close', (params) => {
    deps.lsp?.close(params.path);
  });
  router.register('lsp.restart', () => deps.lsp?.restart() ?? { running: [] });
  router.register('lsp.status', () => deps.lsp?.status() ?? { running: [] });
  // Прокси к серверу: подсказки, наведение, переход к определению. Сервера нет —
  // возвращаем null, и редактор просто не покажет подсказку.
  router.register('lsp.request', (params) => deps.lsp?.request(params.path, params.method, params.params) ?? null);
  // Символы проекта: сервер ищет по всему проекту, а не по открытому файлу.
  router.register('lsp.symbols', (params) => deps.lsp?.projectSymbols(params.query) ?? []);

  /* ── Отладчик (DAP) ────────────────────────────────────────────────────── */

  const requireDebug = (): DebugService => {
    if (!deps.debug) throw new RpcFailure(RpcErrorCode.Internal, 'Отладчик недоступен');
    return deps.debug;
  };

  router.register('debug.start', (params) =>
    requireDebug().start(params.program, { cwd: params.cwd, args: params.args, env: params.env }),
  );
  // Подключение к чужому процессу: ни файла, ни окружения — только адрес инспектора.
  router.register('debug.attach', (params) => requireDebug().attach(params));
  router.register('debug.setBreakpoints', (params) => requireDebug().setBreakpoints(params.path, params.breakpoints));
  router.register('debug.setExceptionBreakpoints', (params) => requireDebug().setExceptionBreakpoints(params));
  router.register('debug.continue', () => requireDebug().resume());
  router.register('debug.step', (params) => requireDebug().step(params.kind));
  router.register('debug.pause', () => requireDebug().pause());
  router.register('debug.stop', () => {
    requireDebug().stop();
  });
  router.register('debug.scopes', (params) => requireDebug().scopes(params.frameId));
  router.register('debug.variables', (params) => requireDebug().variables(params.reference));
  router.register('debug.evaluate', (params) => requireDebug().evaluate(params.expression, params.frameId));
  router.register('debug.hover', (params) => requireDebug().hover(params.expression, params.frameId));
  router.register('debug.setVariable', (params) =>
    requireDebug().setVariable(params.reference, params.name, params.value),
  );
  router.register('debug.setExpression', (params) =>
    requireDebug().setExpression(params.expression, params.value, params.frameId),
  );

  // Кроме PATH смотрим окружение проекта: pylsp, ruff и прочие, поставленные в
  // venv, видит только оно — системный питон чужие пакеты не видит. Окружение
  // идёт первым: сервер из него и запускать предпочтительнее.
  router.register('lsp.detect', async () => {
    const commands = await detectAvailableCommands();
    const root = deps.workspace.rootPath();
    const environments = root ? await findEnvironments(root, process.platform) : [];
    const primary = environments.find((environment) => environment.primary);
    const venvCommands = primary ? await detectVenvCommands(primary.path, process.platform) : [];
    return matchPresets([...venvCommands, ...commands]);
  });

  /**
   * Ассистент выключается мастер-тумблером в настройках. Проверяем на входе:
   * выключенный AI не должен ни ходить в сеть, ни тратить токены — ни через
   * панель, ни через команду. Сохранённые ключи и провайдеры при этом целы.
   */
  const requireAiEnabled = (): void => {
    if (!deps.settings.get().ai.enabled) {
      throw new RpcFailure(RpcErrorCode.Disabled, 'AI выключен в настройках');
    }
  };

  router.register('ai.setApiKey', (params) => deps.settings.setApiKey(params.providerId, params.apiKey));
  // Права агента меняются и во время ответа: main хранит их и перечитывает перед действием.
  router.register('ai.setPermission', (params) => {
    deps.ai.setAutoApprove(params.autoApprove);
  });
  router.register('ai.clearApiKey', (params) => deps.settings.clearApiKey(params.providerId));
  // Проверка серверов MCP из настроек: поднимаем их и показываем инструменты.
  // Без этого кнопка в настройках была бы слепой — об ошибке знал бы только stderr.
  router.register('ai.mcpTools', () => deps.mcp?.status() ?? []);
  router.register('ai.setWebSearchKey', (params) => deps.settings.setWebSearchKey(params.apiKey));
  router.register('ai.clearWebSearchKey', () => deps.settings.clearWebSearchKey());
  router.register('ai.test', (params, ctx) => {
    requireAiEnabled();
    return deps.ai.testConnection(params, ctx.signal);
  });
  router.register('ai.chat', (request: ChatRequest, ctx) => {
    requireAiEnabled();
    return deps.ai.chat(
      request,
      (event, payload) => ctx.emit(event, payload),
      ctx.signal,
      // Правки и подтверждения живут в renderer: там документная модель, undo и интерфейс.
      {
        applyEdits: (edits, autoApprove) =>
          deps.host.request(ctx.sender, 'ai.applyEdits', { edits, autoApprove }, ctx.signal),
        confirmCommand: (command) =>
          deps.host
            .request(ctx.sender, 'ai.confirmCommand', { command }, ctx.signal)
            .then((decision) => decision.allowed),
        getDiagnostics: (path) => deps.host.request(ctx.sender, 'ai.getDiagnostics', { path }, ctx.signal),
        openFile: (path, line, column) =>
          deps.host.request(ctx.sender, 'ai.openFile', { path, line, column }, ctx.signal).then((result) => result.ok),
      },
    );
  });

  // История бесед: renderer её собирает, main только хранит. Каталог — рядом
  // с настройками, по одному файлу на рабочую папку.
  const chatStore = deps.chatStore ?? new ChatStore();
  router.register('ai.chats.load', (params) => chatStore.load(params.root));
  router.register('ai.chats.save', (params) => {
    chatStore.save(params.root, { conversations: params.conversations, activeUid: params.activeUid });
  });

  router.attach();
  deps.host.attach();

  deps.settings.onDidChange((settings) => pushToRenderers(PushTopic.SettingsChanged, settings));

  return router;
}
