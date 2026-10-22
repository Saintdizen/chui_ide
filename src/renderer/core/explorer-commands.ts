import type { Settings } from '../../shared/api';
import type { DefineCommand } from './command-args';
import type { RpcClient } from './rpc';
import type { WorkspaceModel } from './workspace-model';

/**
 * Дерево глазами команд: рендер после смены области, показ пути и две пары
 * «в избранном / закреплён» — ровно те операции, которые здесь нужны.
 */
export interface ExplorerTree {
  render(): void;
  reveal(path: string): void;
  favorites(): string[];
  toggleFavorite(path: string): void;
  pinnedPaths(): string[];
  togglePin(path: string): void;
}

/**
 * Дерево, рабочая область и уведомления — фасет «дерево/rpc».
 *
 * `applySettings` приходит ленивой ссылкой: в `app.ts` она объявлена ниже места
 * регистрации, а нужна только в момент выполнения команды.
 */
export interface ExplorerCommandDeps {
  workspace: WorkspaceModel;
  explorer: ExplorerTree;
  editors: { readonly currentPath: string | null };
  rpc: RpcClient;
  commands: { execute(id: string, ...args: unknown[]): unknown };
  showToast(message: string, kind?: 'error'): void;
  applySettings(settings: Settings): void;
  basename(path: string): string;
}

export function registerExplorerCommands(define: DefineCommand, deps: ExplorerCommandDeps): void {
  const { workspace, explorer, editors, rpc, commands, showToast, applySettings, basename } = deps;

  define({ id: 'workspace.openFolder', title: 'Открыть проект', category: 'Файл', keybinding: 'Ctrl+O' }, async () => {
    const path = await workspace.pick();
    if (!path) return;
    void commands.execute('view.showExplorer');
    showToast(`Открыт проект ${basename(path)}`);
  });

  // Добавить папку в рабочую область: несколько папок в одном окне (см. workspace-model).
  // Активной становится только что добавленная — туда идут git и поиск.
  define({ id: 'workspace.addFolder', title: 'Добавить папку в рабочую область', category: 'Файл' }, async () => {
    if (!workspace.current) {
      showToast('Сначала откройте проект', 'error');
      return;
    }
    const result = await rpc.request('dialog.pickFolder', { title: 'Добавить папку в рабочую область' });
    if (!result.path) return;
    await workspace.addRoot(result.path);
    explorer.render();
    showToast(`В рабочую область добавлена папка ${basename(result.path)}`);
  });

  define({ id: 'workspace.refresh', title: 'Обновить дерево', category: 'Файл' }, async () => {
    await workspace.refresh();
    explorer.render();
  });

  define({ id: 'workspace.revealPath', title: 'Показать в проводнике', category: 'Навигация' }, (path) => {
    if (typeof path === 'string') explorer.reveal(path);
  });

  // Набор значков дерева из файла: правила приносит человек или сторонний набор.
  define({ id: 'explorer.importBadges', title: 'Набор значков дерева из файла…', category: 'Вид' }, async () => {
    const result = await rpc.request('explorer.importBadges', undefined).catch((error: unknown) => {
      showToast(error instanceof Error ? error.message : 'Не удалось прочитать набор значков', 'error');
      return null;
    });
    if (!result) return;
    applySettings(result.settings);
    showToast(result.count > 0 ? `Значков дерева: ${result.count}` : 'Набор значков пуст');
  });

  // Избранное: то же, что пункт меню дерева, но по текущему файлу или папке.
  define({ id: 'explorer.favorite', title: 'В избранное / убрать', category: 'Файл' }, async (path) => {
    const target = typeof path === 'string' && path !== '' ? path : (editors.currentPath ?? workspace.root);
    if (!target) return;
    const wasFavorite = explorer.favorites().includes(target);
    explorer.toggleFavorite(target);
    showToast(wasFavorite ? 'Убрано из избранного' : 'Добавлено в избранное');
  });

  // Закреплённое сверху дерева: то же, что пункт меню, но по текущему файлу.
  define({ id: 'explorer.togglePin', title: 'Закрепить файл в дереве', category: 'Файл' }, async (path) => {
    const target = typeof path === 'string' ? path : editors.currentPath;
    if (!target) return;
    const wasPinned = explorer.pinnedPaths().includes(target);
    explorer.togglePin(target);
    showToast(wasPinned ? 'Откреплено сверху дерева' : 'Закреплено сверху дерева');
  });
}
