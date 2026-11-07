import type { DefineCommand } from './command-args';

/**
 * Настройки: окно и доступ к файлу настроек на диске.
 * Открытие файла идёт через main — он же и создаёт его, если файла ещё нет,
 * поэтому команда не пытается «проверить наличие» сама.
 */

export interface SettingsRpc {
  request(method: 'settings.revealFile'): Promise<{ path: string }>;
  request(method: 'settings.exportProfileTo'): Promise<{ ok: boolean; path?: string; canceled: boolean }>;
  request(method: 'settings.importProfileFrom'): Promise<{ ok: boolean; canceled: boolean }>;
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

  // Профиль — всё рабочее окружение одним файлом: настройки, макет и тема. Так его
  // переносят на другую машину; ключи провайдеров в профиль не входят и приезжают
  // отдельно — иначе файл стал бы переносителем секретов.
  define({ id: 'settings.exportProfile', title: 'Выгрузить профиль в файл', category: 'Настройки' }, async () => {
    const result = await rpc.request('settings.exportProfileTo');
    if (result.canceled) return;
    showToast(result.path ? `Профиль сохранён: ${result.path}` : 'Профиль не сохранён');
  });

  define({ id: 'settings.importProfile', title: 'Загрузить профиль из файла', category: 'Настройки' }, async () => {
    const result = await rpc.request('settings.importProfileFrom');
    if (result.canceled) return;
    showToast(result.ok ? 'Профиль применён' : 'Файл профиля не подошёл');
  });
}
