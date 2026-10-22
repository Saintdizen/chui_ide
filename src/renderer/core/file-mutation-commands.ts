import { objectsWord } from '../../shared/import-install';
import { basename } from '../ui/dom';
import type { ToastKind, ToastOptions } from '../ui/toast';
import type { DefineCommand } from './command-args';
import { copiedToTrash, trackMoves, undoableAfterTrash, undoMoves, type MoveTrack } from './file-actions';
import { deleteManyPrompt, deletePrompt, movedNotice, trashedNotice } from './file-notices';
import type { OpenEditors } from './open-editors';
import type { RpcClient } from './rpc';
import { copyPlan, movePlan } from './tree-move';
import type { WorkspaceModel } from './workspace-model';

/**
 * Команды, которые меняют место файла: удаление в корзину, перенос, копирование.
 *
 * Вынесены из `app.ts` вместе с комментариями о порядке шагов — здесь только
 * диск, вкладки и то, что видит человек. Что именно трогать (план переноса,
 * план копии, «есть ли что возвращать») решают чистые модули: `file-actions`,
 * `tree-move`, `file-notices`. Поэтому зависимостей мало: rpc, открытые
 * вкладки, дерево, настройка подтверждения, уведомления и открытие файла.
 */
export interface FileMutationDeps {
  rpc: RpcClient;
  openEditors: OpenEditors;
  explorer: { scheduleRefresh(): void };
  /** Нужен ровно один флаг: спрашивать ли подтверждение перед удалением. */
  settings: { explorer: { confirmDelete: boolean } };
  workspace: WorkspaceModel;
  showToast(message: string, kind?: ToastKind, options?: ToastOptions): void;
  openPath(path: string): Promise<void>;
}

export function registerFileMutationCommands(define: DefineCommand, deps: FileMutationDeps): void {
  const { rpc, openEditors, explorer, settings, showToast, workspace } = deps;

  define({ id: 'file.delete', title: 'Удалить в корзину', category: 'Файл' }, async (path) => {
    if (typeof path !== 'string') return;

    // Удаление необратимо, поэтому спрашиваем — но только если так настроено:
    // в проводнике это рутинное действие, и лишний вопрос раздражает.
    if (settings.explorer.confirmDelete) {
      const prompt = deletePrompt(basename(path), workspace.relative(path));
      const { confirmed } = await rpc.request('dialog.confirm', {
        title: 'Удалить в корзину',
        ...prompt,
        confirmLabel: 'Удалить',
      });
      if (!confirmed) return;
    }

    if (openEditors.has(path)) openEditors.close(path);
    await rpc.request('workspace.trash', { path });
    explorer.scheduleRefresh();
    showToast(`В корзине: ${basename(path)}`);
  });

  // Восстановления из корзины нет, пока `canUndoTrash()` ложь, — и кнопки
  // отмены в уведомлении поэтому тоже нет: это не забытость, а отсутствие
  // механизма. Число возвращаемых спрашиваем у `undoableAfterTrash`.
  define({ id: 'file.deleteMany', title: 'Удалить выделенное в корзину', category: 'Файл' }, async (paths) => {
    if (!Array.isArray(paths)) return;
    const list = paths.filter((item): item is string => typeof item === 'string');
    if (list.length === 0) return;

    // Вопрос один на всю пачку: спрашивать по разу на файл — то самое раздражение,
    // ради ухода от которого и делают групповое выделение.
    if (settings.explorer.confirmDelete) {
      const { confirmed } = await rpc.request('dialog.confirm', {
        title: 'Удалить в корзину',
        ...deleteManyPrompt(list.length, objectsWord),
        confirmLabel: 'Удалить',
      });
      if (!confirmed) return;
    }

    let removed = 0;
    for (const path of list) {
      try {
        if (openEditors.has(path)) openEditors.close(path);
        await rpc.request('workspace.trash', { path });
        removed += 1;
      } catch {
        // Одного неудачного объекта мало, чтобы отменить удаление остальных.
      }
    }
    explorer.scheduleRefresh();
    const notice = trashedNotice(removed, objectsWord);
    if (notice) showToast(notice);
    // Восстановления из корзины нет (canUndoTrash) — кнопки не обещаем. Число
    // возвращаемых спрашивает undoableAfterTrash, а не литерал на месте.
    if (undoableAfterTrash(removed) > 0) {
      showToast(`Можно вернуть: ${removed}`, 'info', { action: { label: 'Вернуть', run: () => undefined } });
    }
  });

  // Откат переноса пачки: обратный порядок и перевёрнутые рёбра — в undoMoves.
  const undoMoveAll = async (moved: readonly MoveTrack[]): Promise<void> => {
    for (const step of undoMoves(moved)) {
      if (openEditors.has(step.to)) openEditors.close(step.to);
      await rpc.request('workspace.rename', { from: step.from, to: step.to }).catch(() => undefined);
    }
    for (const step of moved) if (step.active) await deps.openPath(step.from);
    explorer.scheduleRefresh();
  };

  define({ id: 'file.moveInto', title: 'Переместить в папку', category: 'Файл' }, async (paths, targetDir) => {
    if (!Array.isArray(paths) || typeof targetDir !== 'string') return;
    const list = paths.filter((item): item is string => typeof item === 'string');
    const steps = movePlan(list, targetDir);
    if (steps.length === 0) return;

    // Открытые вкладки переезжают вместе с файлом: закрываем и открываем по новому
    // пути. Активную возвращаем на экран — иначе перенос выглядел бы как закрытие.
    // Снимок активности — ДО первого переезда: потом активной станет соседняя вкладка,
    // и «был ли на экране» уже не ответить (core/file-actions.ts).
    const tracks = trackMoves(steps, openEditors.active?.path ?? null);
    const moved: MoveTrack[] = [];
    for (const track of tracks) {
      try {
        if (openEditors.has(track.from)) openEditors.close(track.from);
        await rpc.request('workspace.rename', { from: track.from, to: track.to });
        moved.push(track);
      } catch {
        // Имя в целевой папке занято — этот объект пропускаем, остальные переносим.
      }
    }

    explorer.scheduleRefresh();
    if (moved.length === 0) {
      showToast('Перенести не удалось: в целевой папке уже есть такое имя', 'error');
      return;
    }
    for (const step of moved) if (step.active) await deps.openPath(step.to);

    showToast(movedNotice(moved.length, moved.length === 1 ? basename(moved[0]!.to) : null, objectsWord), 'info', {
      action: {
        label: 'Отменить',
        run: () => undoMoveAll(moved),
      },
    });
  });

  define({ id: 'file.copyInto', title: 'Скопировать в папку', category: 'Файл' }, async (paths, targetDir) => {
    if (!Array.isArray(paths) || typeof targetDir !== 'string') return;
    const list = paths.filter((item): item is string => typeof item === 'string');
    const steps = copyPlan(list, targetDir);
    if (steps.length === 0) return;

    const copied: string[] = [];
    for (const step of steps) {
      try {
        const result = await rpc.request('workspace.copy', { from: step.from, to: step.to });
        copied.push(result.path);
      } catch {
        // Имя в целевой папке занято — копию пропускаем, остальные делаем.
      }
    }

    explorer.scheduleRefresh();
    if (copied.length === 0) {
      showToast('Скопировать не удалось: в целевой папке уже есть такое имя', 'error');
      return;
    }
    showToast(
      copied.length === 1
        ? `Скопировано: ${basename(copied[0]!)}`
        : `Скопировано: ${copied.length} ${objectsWord(copied.length)}`,
      'info',
      {
        action: {
          label: 'Отменить',
          run: async () => {
            // Отмена копии — вернуть КОПИЮ в корзину: исходный объект не трогали.
            // Список берёт copiedToTrash — «что трогать» решается в одном месте.
            for (const path of copiedToTrash(copied)) {
              await rpc.request('workspace.trash', { path }).catch(() => undefined);
            }
            explorer.scheduleRefresh();
          },
        },
      },
    );
  });
}
