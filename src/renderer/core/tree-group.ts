/**
 * Группировка файлов папки по роли: тесты, стили, документация, конфигурация,
 * ресурсы и всё остальное (исходники).
 *
 * Дерево показывает папки и файлы вперемешку и по имени: при тридцати файлах
 * `Button.tsx`, `Button.module.css`, `Button.test.tsx`, `README.md` и `tsconfig.json`
 * взгляд спотыкается — родственное лежит врозь. Группировка собирает файлы одного
 * назначения вместе и подписывает полку: «Тесты», «Стили», «Конфигурация».
 *
 * Логика чистая: получает имена и отдаёт группы — без окна и без диска. Поэтому её
 * видно в тестах, а проводнику остаётся нарисовать заголовок и строки.
 *
 * Тесты идут первыми не случайно: по ним чаще всего ходят при правке, а исходники —
 * то, что и так открыто. Ресурсы и конфигурация — в середине, как наименее частые.
 */

import { extensionOf } from './tree-sort';

export type FileGroupId = 'test' | 'style' | 'doc' | 'config' | 'assets' | 'source';

/** Порядок полок сверху вниз. Исходники — в конце: их и так видно. */
export const GROUP_ORDER: readonly FileGroupId[] = ['test', 'style', 'doc', 'config', 'assets', 'source'];

const LABELS: Record<FileGroupId, string> = {
  test: 'Тесты',
  style: 'Стили',
  doc: 'Документация',
  config: 'Конфигурация',
  assets: 'Ресурсы',
  source: 'Исходники',
};

export function groupLabel(id: FileGroupId): string {
  return LABELS[id];
}

const STYLE_EXT = new Set(['css', 'scss', 'sass', 'less', 'styl', 'stylus']);
const DOC_EXT = new Set(['md', 'markdown', 'mdx', 'rst', 'adoc', 'asciidoc', 'txt']);
const CONFIG_EXT = new Set([
  'json',
  'json5',
  'jsonc',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'env',
  'lock',
  'properties',
  'editorconfig',
  'gitignore',
  'gitattributes',
  'npmrc',
  'nvmrc',
  'babelrc',
  'eslintrc',
  'prettierrc',
]);
const ASSET_EXT = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'ico',
  'icns',
  'bmp',
  'svg',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'mp3',
  'wav',
  'ogg',
  'mp4',
  'webm',
  'mov',
  'pdf',
]);
/** Файлы без расширения и с особым именем: у них роль видна по названию, а не по хвосту. */
const CONFIG_NAMES = new Set([
  'dockerfile',
  'makefile',
  'procfile',
  'cmakelists.txt',
  'gemfile',
  'rakefile',
  'justfile',
  'vagrantfile',
]);
/** Тестовые файлы без узнаваемого хвоста: у pytest так принято. */
const TEST_NAMES = new Set(['conftest.py']);

/**
 * Тестовый ли это файл: `foo.test.ts`, `foo.spec.tsx`, `test_foo.py`, `foo_test.py`.
 * Точка перед маркером обязательна, иначе `contest.ts` сойдёт за тест.
 */
function looksLikeTest(name: string): boolean {
  const lower = name.toLowerCase();
  if (TEST_NAMES.has(lower)) return true;
  const segments = lower.split('.');
  if (segments.length >= 3) {
    const marker = segments[segments.length - 2] ?? '';
    if (marker === 'test' || marker === 'spec' || marker === 'tests' || marker === 'specs') return true;
  }
  const stem = segments[0] ?? '';
  return stem.startsWith('test_') || stem.endsWith('_test') || stem.startsWith('spec_') || stem.endsWith('_spec');
}

/** Роль файла по имени. Неизвестное считаем исходником — это безопасное умолчание. */
export function fileGroupOf(name: string): FileGroupId {
  if (looksLikeTest(name)) return 'test';
  const ext = extensionOf(name);
  if (STYLE_EXT.has(ext)) return 'style';
  if (DOC_EXT.has(ext)) return 'doc';
  if (CONFIG_NAMES.has(name.toLowerCase())) return 'config';
  if (CONFIG_EXT.has(ext)) return 'config';
  if (ASSET_EXT.has(ext)) return 'assets';
  return 'source';
}

/** Полка файлов одного назначения: пустых полок в списке не бывает. */
export interface FileGroup<T> {
  readonly id: FileGroupId;
  readonly label: string;
  readonly entries: T[];
}

/**
 * Разложить записи по полкам, сохранив их порядок внутри (он уже задан сортировкой
 * дерева). Полки идут в `GROUP_ORDER`; пустые не возвращаются вовсе.
 */
export function groupByKind<T>(entries: readonly T[], nameOf: (item: T) => string): FileGroup<T>[] {
  const buckets = new Map<FileGroupId, T[]>();
  for (const item of entries) {
    const id = fileGroupOf(nameOf(item));
    const bucket = buckets.get(id);
    if (bucket) bucket.push(item);
    else buckets.set(id, [item]);
  }
  const groups: FileGroup<T>[] = [];
  for (const id of GROUP_ORDER) {
    const bucket = buckets.get(id);
    if (bucket && bucket.length > 0) groups.push({ id, label: LABELS[id], entries: bucket });
  }
  return groups;
}
