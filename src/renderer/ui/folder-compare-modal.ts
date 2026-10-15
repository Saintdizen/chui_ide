import type { FolderCompareEntry } from '../../shared/folder-compare';
import { nameOf, separatorOf } from '../../shared/paths';
import type { RpcClient } from '../core/rpc';
import { clear, h, svgIcon } from './dom';
import { createModal } from './modal';

export interface FolderCompareModalDeps {
  rpc: RpcClient;
  /** Открыть сравнение файла: слева и справа абсолютные пути. */
  openFile(left: string, right: string): void;
  notify(message: string, kind?: 'info' | 'error'): void;
}

export interface FolderCompareModalView {
  element: HTMLElement;
  open(left: string, right: string): Promise<void>;
  close(): void;
}

/** Буква статуса: та же привычная нотация, что у git. */
const CHANGE_LETTER: Record<FolderCompareEntry['change'], string> = {
  added: 'A',
  deleted: 'D',
  modified: 'M',
};

const CHANGE_WORD: Record<FolderCompareEntry['change'], string> = {
  added: 'есть только справа',
  deleted: 'есть только слева',
  modified: 'различается',
};

/**
 * Экран сравнения двух папок: список различающихся файлов. Клик по файлу открывает
 * его сравнение (слева первая папка, справа вторая) — тем же экраном различий.
 *
 * Окно только читает: оно ничего не меняет на диске и не индексирует. Папки берутся
 * из рабочей области, сравнение делает main.
 */
export function createFolderCompareModal(deps: FolderCompareModalDeps): FolderCompareModalView {
  const names = h('span', { class: 'refdiff-summary' });
  const list = h('div', { class: 'refdiff-list' });
  let busy = false;

  const modal = createModal({ className: 'refdiff-modal', title: 'Сравнить папки' });
  modal.body.append(h('div', { class: 'refdiff-toolbar' }, svgIcon('folder', 14), names), list);

  const close = (): void => modal.close();

  /** Абсолютный путь файла на нужной стороне: относительный путь — всегда с «/». */
  const absolute = (base: string, relative: string): string =>
    `${base}${separatorOf(base)}${relative.split('/').join(separatorOf(base))}`;

  return {
    element: modal.element,
    close,
    async open(left, right) {
      modal.open();
      clear(list);
      names.textContent = `${nameOf(left)} ↔ ${nameOf(right)}`;
      modal.title.textContent = 'Сравнить папки';
      if (busy) return;
      busy = true;
      list.append(h('p', { class: 'refdiff-empty' }, 'Сравниваю…'));
      try {
        const result = await deps.rpc.request('workspace.compareFolders', { left, right });
        clear(list);
        modal.title.textContent = `Сравнить: ${nameOf(result.left)} ↔ ${nameOf(result.right)}`;
        if (result.files.length === 0) {
          names.textContent = result.truncated
            ? 'различий не найдено (часть файлов не сравнивалась)'
            : 'Папки совпадают';
          list.append(h('p', { class: 'refdiff-empty' }, 'Различающихся файлов нет.'));
          return;
        }
        // Итог: сколько различается и сколько совпало — по числам видно размер правки.
        names.textContent = [
          `различается: ${result.files.length}`,
          `совпадает: ${result.identical}`,
          ...(result.truncated ? ['часть файлов не сравнивалась'] : []),
        ].join(' · ');

        const fragment = document.createDocumentFragment();
        for (const file of result.files) {
          const row = h(
            'div',
            { class: `refdiff-row is-${file.change}`, title: `${CHANGE_WORD[file.change]}: ${file.path}` },
            h('span', { class: 'refdiff-status' }, CHANGE_LETTER[file.change]),
            h('span', { class: 'refdiff-path' }, file.path),
          );
          row.addEventListener('click', () =>
            deps.openFile(absolute(result.left, file.path), absolute(result.right, file.path)),
          );
          fragment.append(row);
        }
        list.append(fragment);
      } catch (error) {
        clear(list);
        names.textContent = '';
        list.append(h('p', { class: 'refdiff-empty' }, 'Не удалось сравнить папки.'));
        deps.notify(error instanceof Error ? error.message : String(error), 'error');
      } finally {
        busy = false;
      }
    },
  };
}
