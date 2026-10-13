import { BrowserWindow, Menu, type MenuItemConstructorOptions, type WebContents } from 'electron';
import { APP_MENU, menuAccelerators, type MenuNode, type MenuRole } from '../shared/app-menu';
import { menuComboOverrides, type KeybindingOverride } from '../shared/keybindings';
import { PushTopic } from '../shared/api';
import { pushToRenderers } from './ipc/push';

/**
 * Системное меню приложения строится из того же шаблона (`shared/app-menu.ts`),
 * что и наше попап-меню, и остаётся нужным ровно для одного: горячие клавиши.
 * Electron обрабатывает их через меню даже при своей рамке окна, а такие пункты,
 * как масштаб и инструменты разработчика, renderer не увидел бы вовсе.
 *
 * Пользователь видит другое меню: кнопка «☰» открывает наш попап.
 *
 * Клавиши пунктов можно поменять в настройках (`keybindings.overrides` под ключом
 * `menu:<команда>`): здесь они накладываются на шаблон. Меню пересобирается заново
 * при каждом изменении настроек — Electron умеет менять акселераторы только так.
 */
export function createApplicationMenu(overrides: readonly KeybindingOverride[] = []): void {
  // Шаблон + переопределения: где человек поменял клавишу пункта, там и новая.
  const combos = menuAccelerators(menuComboOverrides(overrides));
  const template: MenuItemConstructorOptions[] = [];

  // На macOS первая группа — про само приложение: так устроена системная полоса.
  if (process.platform === 'darwin') template.push({ role: 'appMenu' });

  template.push(...APP_MENU.map((node) => toNativeItem(node, combos)));
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Роли Electron называются так же, кроме масштаба и полного экрана. */
const ROLE_NAMES: Record<MenuRole, MenuItemConstructorOptions['role']> = {
  undo: 'undo',
  redo: 'redo',
  cut: 'cut',
  copy: 'copy',
  paste: 'paste',
  selectAll: 'selectAll',
  reload: 'reload',
  toggleDevTools: 'toggleDevTools',
  zoomReset: 'resetZoom',
  zoomIn: 'zoomIn',
  zoomOut: 'zoomOut',
  fullscreen: 'togglefullscreen',
  quit: 'quit',
};

function toNativeItem(node: MenuNode, combos: ReadonlyMap<string, string>): MenuItemConstructorOptions {
  if (node.separator) return { type: 'separator' };

  // Клавиша пункта: из карты (шаблон с переопределениями) для команд и прямо из
  // шаблона для ролей (масштаб, буфер обмена) — те команды не имеют и не меняются.
  const accelerator = node.command ? combos.get(node.command) : node.accelerator;
  const item: MenuItemConstructorOptions = { label: node.label, accelerator };
  if (node.children) item.submenu = node.children.map((child) => toNativeItem(child, combos));
  else if (node.role) item.role = ROLE_NAMES[node.role];
  else if (node.command) item.click = sendCommand(node.command);
  return item;
}

function sendCommand(command: string): () => void {
  return () => pushToRenderers(PushTopic.MenuCommand, { command });
}

/**
 * Пункт-роль в НАШЕМ меню: renderer не умеет ни буфер обмена, ни масштаб окна,
 * поэтому просит main выполнить действие на самом окне. Набор ролей тот же, что
 * у системного меню, — иначе наш попап и системное меню разошлись бы по смыслу.
 */
export function performMenuRole(webContents: WebContents, role: MenuRole): void {
  switch (role) {
    case 'undo':
      webContents.undo();
      return;
    case 'redo':
      webContents.redo();
      return;
    case 'cut':
      webContents.cut();
      return;
    case 'copy':
      webContents.copy();
      return;
    case 'paste':
      webContents.paste();
      return;
    case 'selectAll':
      webContents.selectAll();
      return;
    case 'reload':
      webContents.reload();
      return;
    case 'toggleDevTools':
      webContents.toggleDevTools();
      return;
    case 'zoomReset':
      webContents.setZoomLevel(0);
      return;
    case 'zoomIn':
      webContents.setZoomLevel(Math.min(webContents.getZoomLevel() + 0.5, 5));
      return;
    case 'zoomOut':
      webContents.setZoomLevel(Math.max(webContents.getZoomLevel() - 0.5, -5));
      return;
    case 'fullscreen': {
      const window = BrowserWindow.fromWebContents(webContents);
      if (window) window.setFullScreen(!window.isFullScreen());
      return;
    }
    case 'quit':
      BrowserWindow.fromWebContents(webContents)?.close();
      return;
  }
}
