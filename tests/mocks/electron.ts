import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Подмена Electron для юнит-тестов.
 *
 * Зачем файл существует: `src/main/*` берёт из electron настоящие значения —
 * `app.getPath('userData')`, `shell.openExternal`, `ipcMain.handle` — и тесты
 * доходят до них транзитом (тест импортирует `git/git.ts` ради `shell`, а тот
 * через `git/exec.ts` доходит до `app`). Пока папка `node_modules/electron`
 * лежала на диске, это никого не смущало; без неё — 52 файла из 459 не
 * загружаются и 506 проверок из 5589 (9%) исчезают МОЛЧА: прогон остаётся
 * зелёным, CI доволен. Проверено снятием пакета 24.10.
 *
 * Правило этого файла: он НЕ ДОЛЖЕН давать тестам лишних возможностей. Всё,
 * что делает вид, что работает, — врёт. `app.getPath` отдаёт настоящий
 * временный каталог (ложь была бы «путь есть, а файлов нет»), а `shell` и
 * `dialog` бросают: тест, дошедший до открытия окна, должен упасть громко, а
 * не пройти на пустышке.
 */

/** Один временный каталог на процесс: userData нужен всем один и тот же. */
const userData = mkdtempSync(path.join(tmpdir(), 'chui-electron-'));

function refuse(what: string): never {
  throw new Error(
    `тест дошёл до ${what}: это Electron, в юнит-тестах его нет. ` +
      'Подмени нужную часть через vi.mock или унеси проверку в scripts/*-smoke.cjs',
  );
}

export const app = {
  getPath: (name: string): string => {
    if (name === 'userData') return userData;
    if (name === 'temp' || name === 'home' || name === 'appData') return tmpdir();
    if (name === 'logs') return path.join(userData, 'logs');
    return userData;
  },
  getAppPath: (): string => process.cwd(),
  getVersion: (): string => '0.0.0-test',
  getName: (): string => 'chui_ide',
  isPackaged: false,
  on: (): void => {},
  once: (): void => {},
  whenReady: async (): Promise<void> => {},
  quit: (): void => refuse('app.quit'),
  exit: (): void => refuse('app.exit'),
  relaunch: (): void => refuse('app.relaunch'),
  requestSingleInstanceLock: (): boolean => true,
  commandLine: { appendSwitch: (): void => {}, appendArgument: (): void => {} },
};

export const shell = {
  openExternal: async (): Promise<void> => refuse('shell.openExternal'),
  openPath: async (): Promise<string> => refuse('shell.openPath'),
  showItemInFolder: (): void => refuse('shell.showItemInFolder'),
  trashItem: async (): Promise<void> => refuse('shell.trashItem'),
};

export const dialog = {
  showOpenDialog: async (): Promise<never> => refuse('dialog.showOpenDialog'),
  showSaveDialog: async (): Promise<never> => refuse('dialog.showSaveDialog'),
  showMessageBox: async (): Promise<never> => refuse('dialog.showMessageBox'),
  showErrorBox: (): void => refuse('dialog.showErrorBox'),
};

/** Регистрацию обработчиков записываем: тест может проверить, что она была. */
export const ipcHandlers = new Map<string, unknown>();
export const ipcMain = {
  handle: (channel: string, fn: unknown): void => {
    ipcHandlers.set(channel, fn);
  },
  removeHandler: (channel: string): void => {
    ipcHandlers.delete(channel);
  },
  on: (): void => {},
  emit: (): void => {},
};

export const protocol = {
  registerSchemesAsPrivileged: (): void => {},
  handle: (): void => {},
};

export const net = {
  fetch: async (): Promise<never> => refuse('net.fetch'),
  connect: (): never => refuse('net.connect'),
};

export const nativeImage = {
  createFromBuffer: (): never => refuse('nativeImage.createFromBuffer'),
  createEmpty: (): never => refuse('nativeImage.createEmpty'),
};

class FakeBrowserWindow {
  static readonly all: FakeBrowserWindow[] = [];
  webContents = { send: (): void => {}, on: (): void => {} };
  constructor() {
    FakeBrowserWindow.all.push(this);
  }
  on(): void {}
  once(): void {}
  loadURL(): Promise<void> {
    return Promise.resolve();
  }
  isDestroyed(): boolean {
    return false;
  }
}

export const BrowserWindow = FakeBrowserWindow;
export const WebContentsView = class {};
export const Menu = {
  setApplicationMenu: (): void => {},
  buildFromTemplate: (): unknown => ({}),
};
