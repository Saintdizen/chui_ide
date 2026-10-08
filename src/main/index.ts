import { app, BrowserWindow, nativeTheme } from 'electron';
import { PushTopic } from '../shared/api';
import { AiService } from './ai/service';
import { GitService } from './git/git';
import { pushToRenderers } from './ipc/push';
import { registerIpc } from './ipc/register';
import { createApplicationMenu } from './menu';
import { registerAppScheme, serveRenderer } from './protocol';
import { SettingsStore } from './settings';
import { TerminalService } from './terminal/terminal';
import { WorkspaceService } from './workspace/workspace';
import { createWelcomeWindow } from './window';

// Схему нужно объявить до инициализации приложения, иначе Chromium не даст ей привилегий.
registerAppScheme();

// Второй экземпляр приложения не нужен: он бы писал в тот же settings.json.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  void app.whenReady().then(() => {
    const settings = new SettingsStore();

    // Схему выбирает main: после смены themeSource Chromium сам присылает renderer'у
    // новое значение prefers-color-scheme, и CSS переключается без правок в DOM.
    // А для того, что CSS не описать (Monaco, xterm), main шлёт resolved-схему
    // отдельным событием — полагаться на событие matchMedia в renderer нельзя.
    const pushTheme = (): void => {
      pushToRenderers(PushTopic.ThemeChanged, {
        theme: settings.get().appearance.theme,
        scheme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
      });
    };

    const applyTheme = (): void => {
      const choice = settings.get().appearance.theme;
      nativeTheme.themeSource = choice;
      const background = nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ececec';
      for (const window of BrowserWindow.getAllWindows()) window.setBackgroundColor(background);
      pushTheme();
    };

    nativeTheme.on('updated', pushTheme);
    settings.onDidChange(applyTheme);
    applyTheme();

    const workspace = new WorkspaceService((topic, payload) => pushToRenderers(topic, payload));
    const ai = new AiService(settings, workspace);
    const terminals = new TerminalService((topic, payload) => pushToRenderers(topic, payload));
    // Git ничего не хранит сам: корень берётся у рабочей папки, а об изменениях
    // узнаём после своих же операций и после сохранения файла.
    const git = new GitService(() => workspace.rootPath(), (topic, payload) => pushToRenderers(topic, payload));

    registerIpc({ settings, workspace, ai, terminals, git });
    serveRenderer();
    createApplicationMenu();
    // Приложение начинается со списка проектов: окно IDE откроется после
    // того, как пользователь выберет папку или склонирует репозиторий.
    createWelcomeWindow();

    app.on('will-quit', () => {
      terminals.dispose();
      workspace.dispose();
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWelcomeWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
