import { basename } from '../ui/dom';
import type { ToastKind, ToastOptions } from '../ui/toast';
import type { CommandRegistry } from './commands';
import type { DefineCommand } from './command-args';
import {
  createFileUndo,
  createFolderUndo,
  prepareRename,
  undoRenamePlan,
  type CreateUndo,
  type RenamePlan,
} from './file-actions';
import { renamedNotice } from './file-notices';
import type { OpenEditors } from './open-editors';
import type { RpcClient } from './rpc';

export interface FileCreateDeps {
  rpc: RpcClient;
  /** Откат переименования закрывает вкладку — через ту же команду, что и человек. */
  commands: CommandRegistry;
  openEditors: OpenEditors;
  explorer: { scheduleRefresh(): void; startCreate(entryKind: 'file' | 'directory'): void };
  /** Нужен один флаг: править ли ссылки на переименованный файл. */
  settings: { explorer: { updateImportsOnRename: boolean } };
  showToast(message: string, kind?: ToastKind, options?: ToastOptions): void;
  openPath(path: string): Promise<void>;
}

/**
 * Создание и переименование на диске.
 *
 * Весь порядок шагов живёт здесь, а не в `app.ts`: сначала закрыть вкладку, потом
 * трогать диск — иначе редактор будет держать файл за прежний дескриптор. Отмена
 * идёт теми же шагами в обратную сторону, и «был ли файл активным» запоминается
 * до закрытия вкладки (иначе активной станет соседняя).
 */
export function registerFileCreateCommands(define: DefineCommand, deps: FileCreateDeps): void {
  const { rpc, commands, openEditors, explorer, settings, showToast, openPath } = deps;

  // Шаги «переименовал» и «вернул» — рядом с обработчиком, потому что оба знают
  // порядок. Настройка updateImportsOnRename гасит только правку ссылок, само
  // переименование не трогает.
  const followRename = async (oldPath: string, newPath: string): Promise<number> => {
    if (!settings.explorer.updateImportsOnRename) return 0;
    const result = await rpc
      .request('workspace.updateImports', { oldPath, newPath })
      .catch(() => ({ files: [] as string[] }));
    return result.files.length;
  };

  const undoRename = async (done: { plan: RenamePlan; to: string; touched: number }): Promise<void> => {
    const back = undoRenamePlan({ from: done.plan.from, to: done.to, touched: done.touched });
    await commands.execute('file.close', back.from);
    await rpc.request('workspace.rename', { from: back.from, to: back.to });
    // Ссылки возвращаются тем же путём — иначе отмена оставила бы в проекте
    // ссылки на исчезнувший путь.
    if (back.restoreImports) await followRename(back.from, back.to);
    if (done.plan.wasActive) await openPath(back.to);
    explorer.scheduleRefresh();
  };

  // Отмена создания: сначала закрыть вкладку (для файла), потом унести в корзину.
  // У папки вкладки нет — это решает createFolderUndo, а не `if` на месте вызова.
  const undoCreate = async (undo: CreateUndo): Promise<void> => {
    if (undo.closeTab && undo.closePath) await commands.execute('file.close', undo.closePath);
    await rpc.request('workspace.trash', { path: undo.trashPath }).catch(() => undefined);
    explorer.scheduleRefresh();
  };

  define({ id: 'file.createFile', title: 'Создать файл', category: 'Файл' }, async (path) => {
    if (typeof path !== 'string') return undefined;
    const created = await rpc.request('workspace.createFile', { path });
    await openPath(created.path);
    explorer.scheduleRefresh();
    // Сразу предлагаем отменить: файл могли создать по ошибке в неверной папке.
    showToast(`Создан файл ${basename(created.path)}`, 'info', {
      action: {
        label: 'Отменить',
        run: () => undoCreate(createFileUndo(created.path)),
      },
    });
    return created.path;
  });

  define({ id: 'file.createFolder', title: 'Создать папку', category: 'Файл' }, async (path) => {
    if (typeof path !== 'string') return undefined;
    const created = await rpc.request('workspace.createDir', { path });
    explorer.scheduleRefresh();
    showToast(`Создана папка ${basename(created.path)}`, 'info', {
      action: {
        label: 'Отменить',
        run: () => undoCreate(createFolderUndo(created.path)),
      },
    });
    return created.path;
  });

  // Из меню и палитры создание начинается с инлайн-ввода имени в дереве.
  define({ id: 'file.newFile', title: 'Новый файл…', category: 'Файл', keybinding: 'Ctrl+N' }, () => {
    explorer.startCreate('file');
  });

  define({ id: 'file.newFolder', title: 'Новая папка…', category: 'Файл' }, () => {
    explorer.startCreate('directory');
  });

  // Сценарий по шагам. Порядок не косметика: активность запоминается ДО закрытия
  // вкладки (иначе активной уже будет соседняя), прежнее имя и число правленных
  // ссылок — до возврата, откат идёт через те же шаги в обратную сторону.
  // Решения о порядке — в core/file-actions.ts, здесь только диск и окна.
  define({ id: 'file.rename', title: 'Переименовать', category: 'Файл' }, async (from, to) => {
    if (typeof from !== 'string' || typeof to !== 'string') return undefined;
    const plan = prepareRename(from, openEditors.active?.path ?? null, openEditors.has(from));
    if (plan.hadTab) openEditors.close(plan.from);

    const renamed = await rpc.request('workspace.rename', { from: plan.from, to });
    const touched = await followRename(plan.from, renamed.path);
    if (plan.wasActive) await openPath(renamed.path);
    explorer.scheduleRefresh();

    showToast(renamedNotice({ name: basename(renamed.path), touched }), 'info', {
      action: {
        label: 'Отменить',
        run: () => undoRename({ plan, to: renamed.path, touched }),
      },
    });
    return renamed.path;
  });
}
