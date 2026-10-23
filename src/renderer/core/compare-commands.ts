import type { DefineCommand } from './command-args';
import { pairFromSelection } from './file-compare';

/**
 * Команды сравнения: две папки, два файла, файл с подобранным, выделенная пара.
 * Сами правила «кого с кем сравнивать» живут в `file-compare.ts` — здесь только
 * разбор аргументов команды и выбор экрана. Папки показываем списком различий,
 * файлы — построчным экраном; это разные представления, и путать их нельзя.
 */

/** Экран различий двух файлов (из дерева, из git, из сравнения). */
export interface CompareDiffView {
  openFiles(left: string, right: string): Promise<unknown>;
}

/** Список различий двух папок. */
export interface CompareFolderModal {
  open(left: string, right: string): Promise<unknown>;
}

/** Быстрый открыватель: им выбирают второй файл для «Сравнить с…». */
export interface CompareQuickOpen {
  pick(title: string): Promise<string | null>;
}

export interface CompareDeps {
  diffView: CompareDiffView;
  folderCompare: CompareFolderModal;
  quickOpen: CompareQuickOpen;
}

export function registerCompareCommands(define: DefineCommand, deps: CompareDeps): void {
  const { diffView, folderCompare, quickOpen } = deps;

  // Сравнение двух папок: список различий, клик по файлу открывает его сравнение.
  define({ id: 'folder.compare', title: 'Сравнить папки', category: 'Навигация' }, async (left, right) => {
    if (typeof left !== 'string' || typeof right !== 'string') return;
    await folderCompare.open(left, right);
  });

  // Сравнение двух файлов — из дерева, тем же экраном, что показывает git-различия.
  // Это просмотр: блоки без кнопок индексации.
  define({ id: 'diff.compareFiles', title: 'Сравнить два файла', category: 'Навигация' }, async (left, right) => {
    if (typeof left !== 'string' || typeof right !== 'string') return;
    await diffView.openFiles(left, right);
  });

  // «Сравнить с…»: выбранный файл и подобранный быстрым открывателем. Так сравнивают
  // с файлом из другой папки, не раскрывая дерево до него.
  define({ id: 'file.compareWith', title: 'Сравнить с…', category: 'Файл' }, async (path) => {
    if (typeof path !== 'string') return;
    const other = await quickOpen.pick('С чем сравнить?');
    if (!other || other === path) return;
    await diffView.openFiles(path, other);
  });

  // Ровно два файла в выделении — сравниваем их между собой без вопросов.
  define({ id: 'file.compareSelection', title: 'Сравнить выделенные файлы', category: 'Файл' }, async (paths) => {
    if (!Array.isArray(paths)) return;
    const list = paths.filter((item): item is string => typeof item === 'string');
    const pair = pairFromSelection(list);
    if (!pair) return;
    await diffView.openFiles(pair.left, pair.right);
  });
}
