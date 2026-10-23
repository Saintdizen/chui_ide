import type { Settings, SettingsPatch } from '../../shared/api';
import { addressProblem } from '../../shared/fs-address';
import type { DefineCommand } from './command-args';

/**
 * Команды над путём: показать/открыть файл средствами системы, поднять терминал
 * в нужной папке, прыгнуть к позиции, подключить удалённую папку.
 *
 * Их много и они мелкие, но смысл общий: у команды нет «своего» объекта — она
 * берёт путь и передаёт его наружу. Поэтому и портов немного.
 */

export interface PathRpc {
  request(
    method: 'shell.revealInOS' | 'shell.openPath' | 'shell.openTerminal',
    payload: { path: string },
  ): Promise<{
    ok: boolean;
  }>;
  request(method: 'remote.check', payload: { address: string }): Promise<{ ok: boolean; detail?: string }>;
}

export interface PathDeps {
  rpc: PathRpc;
  workspace: { readonly root: string | null };
  /** Только нужная часть настроек: список подключённых папок. */
  settings: { readonly workspace: Pick<Settings['workspace'], 'remoteRoots'> };
  saveSettingsPatch(patch: SettingsPatch): Promise<Settings>;
  showToast(message: string, kind?: 'error'): void;
  openPath(path: string): Promise<unknown>;
  editors: { reveal(path: string, line: number, column: number): void };
  dock: { show(view: 'terminal'): void };
  terminalPanel: { newSession(cwd: string): Promise<unknown> };
  historyModal: { open(path: string): Promise<unknown> };
  remoteFileModal: { open(address: string): Promise<unknown> };
  conditionInput: {
    open(options: {
      title: string;
      label: string;
      placeholder: string;
      confirmLabel: string;
      onAccept(value: string): void;
    }): void;
  };
  /** Куда положить выбранную папку для окна её настроек — состояние `app`. */
  setRootSettingsTarget(path: string): void;
  rootSettingsModal: { open(): void };
}

export function registerPathCommands(define: DefineCommand, deps: PathDeps): void {
  const { rpc, workspace, settings, saveSettingsPatch, showToast } = deps;

  define({ id: 'file.revealInOS', title: 'Показать в системном проводнике', category: 'Файл' }, async (path) => {
    if (typeof path !== 'string') return;
    const { ok } = await rpc.request('shell.revealInOS', { path });
    if (!ok) showToast('Не удалось показать в проводнике системы', 'error');
  });

  define({ id: 'file.openExternal', title: 'Открыть внешней программой', category: 'Файл' }, async (path) => {
    if (typeof path !== 'string') return;
    const { ok } = await rpc.request('shell.openPath', { path });
    if (!ok) showToast('Система не нашла, чем открыть файл', 'error');
  });

  define(
    {
      id: 'file.history',
      title: 'Локальная история файла',
      category: 'Файл',
      keywords: ['история', 'снимки', 'локальная', 'timeline', 'восстановить версию'],
    },
    (path) => {
      if (typeof path !== 'string') return;
      void deps.historyModal.open(path);
    },
  );

  // Терминал поднимается в нужной папке: у открытого файла — рядом с ним, у папки —
  // в ней самой. Сессию создаём ДО показа дока: показ сам открывает терминал, и та
  // сессия ушла бы в корень области — наш каталог потерялся бы (гонка `creating`).
  define({ id: 'terminal.openIn', title: 'Терминал в папке', category: 'Терминал' }, async (target) => {
    const path = typeof target === 'string' && target !== '' ? target : workspace.root;
    if (!path) return;
    await deps.terminalPanel.newSession(path);
    deps.dock.show('terminal');
  });

  // Системный терминал — внешним окном: для долгих интерактивных сессий, где
  // встроенная панель мешает. Своя программа берётся из настройки `TERMINAL`.
  define({ id: 'terminal.openExternal', title: 'Терминал системы в папке', category: 'Терминал' }, async (target) => {
    const path = typeof target === 'string' && target !== '' ? target : workspace.root;
    if (!path) return;
    const { ok } = await rpc.request('shell.openTerminal', { path });
    if (!ok) showToast('Не нашёл терминал: задайте свой в настройке `TERMINAL`', 'error');
  });

  define({ id: 'file.revealAt', title: 'Перейти к позиции', category: 'Навигация' }, async (path, line, column) => {
    if (typeof path !== 'string') return;
    await deps.openPath(path);
    deps.editors.reveal(path, typeof line === 'number' ? line : 1, typeof column === 'number' ? column : 1);
  });

  /**
   * Подключить удалённую папку: адрес спрашиваем строкой (системный диалог папки
   * локальный — удалённую папку он выбрать не может), проверяем разбором и клиентом.
   */
  const addRemoteRoot = (): void => {
    deps.conditionInput.open({
      title: 'Удалённая папка',
      label: 'Адрес',
      placeholder: 'ssh://user@host/srv/app',
      confirmLabel: 'Подключить',
      onAccept: (value) => void connectRemoteRoot(value),
    });
  };

  const connectRemoteRoot = async (value: string): Promise<void> => {
    const problem = addressProblem(value);
    if (problem) {
      showToast(problem, 'error');
      return;
    }
    // Клиент проверяем ДО записи в настройки: без ssh/wsl/docker адрес открывать нечем,
    // и лучше сказать это сразу, чем оставить молча нерабочую строку в списке.
    const check = await rpc
      .request('remote.check', { address: value })
      .catch((error: unknown) => ({ ok: false, detail: error instanceof Error ? error.message : String(error) }));
    if (!check.ok) {
      showToast(check.detail ?? 'Удалённая папка недоступна', 'error');
      return;
    }
    const roots = settings.workspace.remoteRoots;
    if (roots.includes(value)) {
      showToast('Такая папка уже подключена');
      return;
    }
    await saveSettingsPatch({ workspace: { remoteRoots: [...roots, value] } });
    showToast(`Подключено: ${check.detail || value}`);
  };

  define({ id: 'remote.addRoot', title: 'Подключить удалённую папку…', category: 'Вид' }, () => addRemoteRoot());

  define({ id: 'remote.openFile', title: 'Открыть удалённый файл…', category: 'Вид' }, (address) => {
    if (typeof address !== 'string' || address === '') return;
    void deps.remoteFileModal.open(address);
  });

  // Настройки вида дерева для одной папки области: пункт меню у строки корня.
  define({ id: 'explorer.rootSettings', title: 'Настройки папки…', category: 'Вид' }, (path) => {
    const target = typeof path === 'string' && path !== '' ? path : workspace.root;
    if (!target) {
      deps.setRootSettingsTarget('');
      showToast('Папка не открыта', 'error');
      return;
    }
    deps.setRootSettingsTarget(target);
    deps.rootSettingsModal.open();
  });
}
