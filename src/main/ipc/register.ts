import { app, BrowserWindow, dialog, shell } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  CloneEvent,
  MAX_CHAT_IMAGES,
  PushTopic,
  RpcErrorCode,
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
import type { LspService } from '../lsp/lsp';
import { performMenuRole } from '../menu';
import type { SettingsStore } from '../settings';
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
}

/**
 * Связываем сервисы с контрактом RPC. Компилятор следит за тем, чтобы
 * аргументы и результат каждого метода совпадали с shared/api.ts.
 */
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

  router.register('app.info', (): AppInfo => ({
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
  }));

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

  router.register('workspace.readDir', (params) => deps.workspace.readDir(params.path));
  router.register('workspace.readFile', (params) => deps.workspace.readFile(params.path));
  router.register('workspace.writeFile', async (params) => {
    const result = await deps.workspace.writeFile(params.path, params.text);
    refreshGit();
    return result;
  });
  router.register('workspace.stat', (params) => deps.workspace.stat(params.path));
  router.register('workspace.search', (params) => deps.workspace.search(params));
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

  /* ── стартовое окно ────────────────────────────────────────────────────── */

  /** Недавние проекты с проверкой, что папка ещё на месте. */
  const recentProjects = async (): Promise<RecentProject[]> => {
    const recent = deps.settings.get().workspace.recent;
    return Promise.all(
      recent.map(async (root) => ({
        path: root,
        name: path.basename(root) || root,
        exists: await fs.stat(root).then((stat) => stat.isDirectory()).catch(() => false),
      })),
    );
  };

  router.register('app.recentProjects', recentProjects);

  router.register('app.forgetProject', (params) => {
    deps.settings.forgetProject(params.path);
    return recentProjects();
  });

  /**
   * Переход из стартового окна в IDE: открываем папку, запоминаем её и создаём
   * окно редактора. Стартовое окно закрывает сам лаунчер, получив ответ, —
   * закрытие здесь уничтожило бы окно раньше отправки ответа, и вызов в renderer
   * остался бы без результата.
   */
  router.register('app.openProject', async (params) => {
    const info = await deps.workspace.open(params.path);
    deps.settings.rememberProject(info.root);
    openIdeWindow();
    await deps.git.refresh();
    return { root: info.root, name: info.name };
  });

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

  router.register('terminal.create', (params) => deps.terminals.create(params));
  router.register('terminal.write', (params) => {
    deps.terminals.write(params.id, params.data);
  });
  router.register('terminal.resize', (params) => {
    deps.terminals.resize(params.id, params.cols, params.rows);
  });
  router.register('terminal.kill', (params) => {
    deps.terminals.kill(params.id);
  });
  router.register('terminal.list', () => deps.terminals.list());

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
  router.register('window.setBounds', (params: Partial<WindowBounds>, ctx) =>
    applyBounds(senderWindow(ctx), params),
  );
  router.register('menu.role', (params, ctx) => {
    performMenuRole(senderWindow(ctx).webContents, params.role);
  });

  router.register('settings.get', () => deps.settings.get());  router.register('settings.update', (patch: SettingsPatch) => deps.settings.update(patch));
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

  router.register('ai.setApiKey', (params) => deps.settings.setApiKey(params.providerId, params.apiKey));
  router.register('ai.clearApiKey', (params) => deps.settings.clearApiKey(params.providerId));
  router.register('ai.models', (params, ctx) => deps.ai.models(params.providerId, ctx.signal));
  router.register('ai.test', (params, ctx) => deps.ai.testConnection(params, ctx.signal));
  router.register('ai.chat', (request: ChatRequest, ctx) =>
    deps.ai.chat(
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
          deps.host
            .request(ctx.sender, 'ai.openFile', { path, line, column }, ctx.signal)
            .then((result) => result.ok),
      },
    ),
  );

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
