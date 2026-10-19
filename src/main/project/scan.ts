import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildScan, isIgnoredDirectory, type ProjectScan } from '../../shared/project-scan';

/**
 * Обход проекта для карты: какие файлы и каталоги в нём есть.
 *
 * Скан — отдельная ответственность, поэтому и обход свой, а не общий с поиском
 * по рабочей папке: у поиска свои задачи (совпадения) и свой список служебных
 * каталогов. Здесь важно не читать содержимое файлов вообще — только имена,
 * поэтому скан дешёвый и не тормозит main на большом репозитории.
 */

/** Потолок обхода: огромное дерево не должно вешать main и копить память. */
const MAX_SCAN_FILES = 20_000;

/** Свежая карта проекта: имена файлов и каталогов без чтения содержимого. */
export async function scanProject(root: string): Promise<ProjectScan> {
  const { files, dirCount } = await listProjectFiles(root);
  return buildScan({ root, name: path.basename(root) || root, files, dirCount });
}

/**
 * Все файлы проекта (относительные POSIX-пути) и число каталогов.
 *
 * Отдельно от сводки, потому что сводку видят и renderer, и агент, а полный список
 * путей им не нужен и стоит тысяч строк в ответе. Здесь же его берёт карта символов:
 * ей нужны файлы, а не сводка.
 */
export async function listProjectFiles(root: string): Promise<{ files: string[]; dirCount: number }> {
  const files: string[] = [];
  let dirCount = 0;

  const walk = async (dir: string): Promise<void> => {
    if (files.length >= MAX_SCAN_FILES) return;
    const dirents = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const dirent of dirents) {
      if (files.length >= MAX_SCAN_FILES) return;
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        if (isIgnoredDirectory(dirent.name)) continue;
        dirCount += 1;
        await walk(full);
        continue;
      }
      if (!dirent.isFile()) continue; // симлинки и прочее — не код проекта
      files.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };

  await walk(root);
  return { files, dirCount };
}
