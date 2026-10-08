import { Menu, type MenuItemConstructorOptions } from 'electron';
import { PushTopic } from '../shared/api';
import { pushToRenderers } from './ipc/push';

/**
 * Меню — источник команд, а не место логики: каждый пункт просто отправляет
 * идентификатор команды в renderer, где его исполняет тот же реестр, что и кнопки UI.
 */
export function createApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [];

  if (process.platform === 'darwin') template.push({ role: 'appMenu' });

  template.push(
    {
      label: 'Файл',
      submenu: [
        { label: 'Открыть папку…', accelerator: 'CmdOrCtrl+O', click: sendCommand('workspace.openFolder') },
        { type: 'separator' },
        { label: 'Новый файл', accelerator: 'CmdOrCtrl+N', click: sendCommand('file.newFile') },
        { label: 'Новая папка', click: sendCommand('file.newFolder') },
        { type: 'separator' },
        { label: 'Сохранить', accelerator: 'CmdOrCtrl+S', click: sendCommand('file.save') },
        { label: 'Сохранить всё', accelerator: 'CmdOrCtrl+Shift+S', click: sendCommand('file.saveAll') },
        { label: 'Закрыть вкладку', accelerator: 'CmdOrCtrl+W', click: sendCommand('file.close') },
        { type: 'separator' },
        { label: 'Обновить дерево', accelerator: 'CmdOrCtrl+R', click: sendCommand('workspace.refresh') },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close', label: 'Закрыть окно' } : { role: 'quit', label: 'Выход' },
      ],
    },
    {
      label: 'Правка',
      submenu: [
        { role: 'undo', label: 'Отменить' },
        { role: 'redo', label: 'Повторить' },
        { type: 'separator' },
        { role: 'cut', label: 'Вырезать' },
        { role: 'copy', label: 'Копировать' },
        { role: 'paste', label: 'Вставить' },
        { role: 'selectAll', label: 'Выделить всё' },
        { type: 'separator' },
        { label: 'Найти в проекте', accelerator: 'CmdOrCtrl+Shift+F', click: sendCommand('search.project') },
      ],
    },
    {
      label: 'Вид',
      submenu: [
        { label: 'Боковая панель', accelerator: 'CmdOrCtrl+B', click: sendCommand('view.toggleSidebar') },
        { label: 'Панель AI', accelerator: 'CmdOrCtrl+Shift+A', click: sendCommand('view.toggleRight') },
        { type: 'separator' },
        { label: 'Терминал', accelerator: 'Alt+F12', click: sendCommand('view.showTerminal') },
        { label: 'Поиск по проекту', accelerator: 'CmdOrCtrl+Shift+F', click: sendCommand('search.project') },
        { type: 'separator' },
        { label: 'Палитра команд…', accelerator: 'CmdOrCtrl+Shift+P', click: sendCommand('palette.open') },
        { type: 'separator' },
        { label: 'Тема: тёмная', click: sendCommand('view.theme.dark') },
        { label: 'Тема: светлая', click: sendCommand('view.theme.light') },
        { label: 'Тема: как в системе', click: sendCommand('view.theme.system') },
        { type: 'separator' },
        { role: 'reload', label: 'Перезагрузить' },
        { role: 'toggleDevTools', label: 'Инструменты разработчика' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Обычный масштаб' },
        { role: 'zoomIn', label: 'Крупнее' },
        { role: 'zoomOut', label: 'Мельче' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Полный экран' },
      ],
    },
    {
      label: 'AI',
      submenu: [
        { label: 'Новый диалог', accelerator: 'CmdOrCtrl+Shift+N', click: sendCommand('ai.newChat') },
        { label: 'Остановить генерацию', click: sendCommand('ai.stop') },
        { type: 'separator' },
        { label: 'Объяснить выделение', click: sendCommand('ai.explainSelection') },
        { label: 'Исправить выделение', click: sendCommand('ai.fixSelection') },
      ],
    },
  );

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function sendCommand(command: string): () => void {
  return () => pushToRenderers(PushTopic.MenuCommand, { command });
}
