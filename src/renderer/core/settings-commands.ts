import type { DefineCommand } from './command-args';

/**
 * Настройки: окно и доступ к файлу настроек на диске.
 * Открытие файла идёт через main — он же и создаёт его, если файла ещё нет,
 * поэтому команда не пытается «проверить наличие» сама.
 */

export interface SettingsRpc {
  request(method: 'settings.revealFile'): Promise<{ path: string }>;
}

export interface SettingsModal {
  open(): void;
}

export interface SettingsDeps {
  rpc: SettingsRpc;
  settingsModal: SettingsModal;
  showToast(message: string, kind?: 'error'): void;
}

export function registerSettingsCommands(define: DefineCommand, deps: SettingsDeps): void {
  const { rpc, settingsModal, showToast } = deps;

  define({ id: 'settings.open', title: 'Настройки', category: 'Настройки', keybinding: 'Ctrl+,' }, () =>
    settingsModal.open(),
  );

  // Открыть settings.json: править руками удобнее, когда видно весь файл целиком,
  // а не одно поле в окне. Путь main возвращает сам — гадать о расположении не нужно.
  define({ id: 'settings.revealFile', title: 'Открыть settings.json', category: 'Настройки' }, async () => {
    const result = await rpc.request('settings.revealFile');
    showToast(`Настройки: ${result.path}`);
  });
}
