import { promises as fs } from 'node:fs';
import path from 'node:path';
import { languageInfoForPath } from '../../shared/languages';
import { isIgnoredDirectory, isTestFile } from '../../shared/project-scan';
import { scanProject } from '../project/scan';

/**
 * Файл-затравка для языкового сервера: первый подходящий файл языка в проекте.
 *
 * Нужен для обхода проекта (`LspService.scanProject`). Сервер, которому не открыли
 * ни одного файла, проекта не знает: `tsserver` в таком состоянии отвечает на
 * `workspace/symbol` ошибкой «No Project.», и индекс не собирался вовсе — поиск
 * символов по проекту был пуст, пока человек не откроет вкладку. Открыв серверу
 * один файл языка, мы даём ему точку входа: дальше он читает проект сам.
 *
 * Почему отдельный обход, а не карта проекта: карта отдаёт только СЧЁТ по языкам
 * (`ProjectScan.languages`), а нужен конкретный путь. Обход дешёвый — имена без
 * чтения содержимого, служебные каталоги пропускаются — и кешируется на корень:
 * серверов бывает восемь, а проект один.
 */

/** Потолок обхода: затравка не повод обойти бесконечное дерево. */
const MAX_DIRS = 4_000;

/**
 * Файл больше этого не открываем серверу: `didOpen` с мегабайтным текстом — это
 * лишний разбор и лишняя память у сервера. Такой файл кодом проекта обычно не является.
 */
const MAX_SEED_BYTES = 512 * 1024;

/** Кандидаты в затравку: если первый не прочитался, берём следующий. */
const CANDIDATES_PER_LANGUAGE = 5;

export interface SeedDocument {
  path: string;
  text: string;
}

export interface SeedProvider {
  /** Файл языка и его текст; `null` — файлов этого языка в проекте нет. */
  (language: string): Promise<SeedDocument | null>;
}

/**
 * Поставщик затравок для текущего корня. Корень берём функцией: он меняется вместе
 * с проектом, а сервис живёт всё окно.
 */
export function createSeedProvider(root: () => string | null): SeedProvider {
  /** Пути-кандидаты по языкам для одного корня: обход делается один раз на проект. */
  let cached: { root: string; byLanguage: Map<string, string[]> } | null = null;

  async function collect(rootPath: string, language: string): Promise<string[]> {
    if (cached?.root !== rootPath) cached = { root: rootPath, byLanguage: new Map() };
    const known = cached.byLanguage.get(language);
    if (known) return known;

    const found: string[] = [];
    // Точки входа проекта — раньше всех: такой файл точно в сборке проекта (в его
    // `tsconfig`/пакете), а не одинокий конфиг вроде `vite.config.mts`. Разница не
    // косметическая: `tsserver` открывает ПРОЕКТ, в который входит файл, — открыв
    // одинокий конфиг, мы получили бы индекс из одного файла.
    const scan = await scanProject(rootPath).catch(() => null);
    if (scan) {
      for (const relative of scan.entryPoints) {
        const absolute = path.join(rootPath, ...relative.split('/'));
        if (languageInfoForPath(absolute)?.id === language && !isTestFile(relative)) found.push(absolute);
      }
    }

    // Остальное — обход в ширину: ближние к корню файлы представительнее, чем
    // примеры из глубоких служебных каталогов.
    const queue: string[] = [rootPath];
    let visited = 0;
    while (queue.length > 0 && visited < MAX_DIRS && found.length < CANDIDATES_PER_LANGUAGE) {
      const dir = queue.shift() as string;
      visited += 1;
      const dirents = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const dirent of dirents) {
        if (found.length >= CANDIDATES_PER_LANGUAGE) break;
        if (!dirent.isFile()) continue;
        const full = path.join(dir, dirent.name);
        if (found.includes(full)) continue;
        if (languageInfoForPath(full)?.id !== language) continue;
        // Тест — не представитель кода: серверу нужен файл, который описывает проект.
        if (isTestFile(path.relative(rootPath, full).split(path.sep).join('/'))) continue;
        found.push(full);
      }
      for (const dirent of dirents) {
        if (!dirent.isDirectory() || isIgnoredDirectory(dirent.name)) continue;
        // Скрытые каталоги — не код проекта: `.chui_ide`, `.github`, `.git`.
        if (dirent.name.startsWith('.')) continue;
        queue.push(path.join(dir, dirent.name));
      }
    }

    cached.byLanguage.set(language, found);
    return found;
  }

  return async (language) => {
    const rootPath = root();
    if (!rootPath) return null;
    for (const candidate of await collect(rootPath, language)) {
      const info = await fs.stat(candidate).catch(() => null);
      if (!info || info.size > MAX_SEED_BYTES) continue;
      const text = await fs.readFile(candidate, 'utf8').catch(() => null);
      if (text !== null) return { path: candidate, text };
    }
    return null;
  };
}
