/**
 * `list` с `depth` — дерево папки глазами модели.
 *
 * Плоский список называет только первый уровень, и модель обходит дерево
 * `list` за `list` — по шагу на папку. Глубина в три уровня отвечает на «как
 * устроен проект» одним вызовом.
 *
 * Ограничители: `depth` (сколько уровней), `limit` (сколько записей всего —
 * дерево легко раздувается) и `maxLines` (сколько строк отдать). Дальше —
 * пометка «ещё N», чтобы модель знала, что список не полон.
 */
import type { DirEntry } from '../../shared/api';
import type { WorkspaceService } from '../workspace/workspace';
import { describe, relative } from './agent-terminal';
import { optionalInteger, optionalString } from './tool-args';
import { MAX_DIR_ENTRIES } from './tool-rules';
import type { ToolOutcome } from './tool-context';

/** Сколько уровней по умолчанию и сколько всего. */
const DEFAULT_TREE_DEPTH = 3;
const MAX_TREE_DEPTH = 8;
/** Потолок строк дерева: одна строка — один путь, как у машиночитаемого вывода. */
const DEFAULT_TREE_LINES = 400;
const MAX_TREE_LINES = 2000;

interface TreeNode {
  readonly entry: DirEntry;
  readonly depth: number;
}

/** Глубина дерева: 0 — не раскрывать, 1 — записи папки, дальше — вглубь. */
export function treeDepth(args: Record<string, unknown>): number {
  const value = optionalInteger(args, 'depth');
  if (value === undefined || value <= 0) return DEFAULT_TREE_DEPTH;
  return Math.min(value, MAX_TREE_DEPTH);
}

export function treeMaxLines(args: Record<string, unknown>): number {
  const value = optionalInteger(args, 'maxLines');
  if (value === undefined || value <= 0) return DEFAULT_TREE_LINES;
  return Math.min(value, MAX_TREE_LINES);
}

/**
 * Обход папки в ширину до заданной глубины: сначала всё, что лежит рядом,
 * потом вглубь. Так модель видит соседей прежде, чем внуков, — и обрывается
 * по `limit` на самом полезном уровне, а не в середине одной ветки.
 *
 * `maxEntries` — общий потолок: дерево большого проекта иначе съест контекст
 * одним вызовом. Внутри одной папки не больше `MAX_DIR_ENTRIES` записей: у
 * `node_modules`-подобных каталогов хвост бесполезен.
 */
export async function collectTree(
  workspace: WorkspaceService,
  start: string,
  options: { depth: number; maxEntries: number },
): Promise<{ nodes: TreeNode[]; truncated: boolean }> {
  const nodes: TreeNode[] = [];
  let truncated = false;
  let level: string[] = [start];
  for (let depth = 1; depth <= options.depth && level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const dir of level) {
      let entries: DirEntry[];
      try {
        entries = await workspace.readDir(dir);
      } catch {
        // Папку не прочитать (права, гонка) — не валим дерево целиком.
        continue;
      }
      if (entries.length > MAX_DIR_ENTRIES) truncated = true;
      for (const entry of entries.slice(0, MAX_DIR_ENTRIES)) {
        if (nodes.length >= options.maxEntries) {
          truncated = true;
          break;
        }
        nodes.push({ entry, depth });
        if (entry.kind === 'directory' && depth < options.depth) next.push(entry.path);
      }
      if (nodes.length >= options.maxEntries) {
        truncated = true;
        break;
      }
    }
    if (nodes.length >= options.maxEntries) {
      truncated = true;
      break;
    }
    level = next.filter((dir) => dir !== start);
  }
  return { nodes, truncated };
}

/**
 * Строки дерева: отступ по глубине и те же пометки, что у плоского списка
 * (слэш у папки, крупный размер, ссылка с целью).
 */
export function treeLines(nodes: readonly TreeNode[], root: string | null, maxLines: number): {
  text: string;
  shown: number;
  total: number;
} {
  const rows = nodes.map(({ entry, depth }) => `${'  '.repeat(Math.max(0, depth - 1))}${describe(entry, root)}`);
  const shown = rows.slice(0, maxLines);
  return { text: shown.join('\n'), shown: shown.length, total: rows.length };
}

/** Хвост дерева: сколько не показано и чем раскрыть остальное. */
export function treeTail(params: {
  truncated: boolean;
  total: number;
  shown: number;
  depth: number;
  path: string;
}): string {
  const parts: string[] = [];
  // Потолок записей и потолок строк — один и тот же счёт с двух сторон: в
  // дереве каждая запись — строка, так что оба обрыва значит «увеличь maxLines».
  if (params.shown < params.total) {
    parts.push(`показаны ${params.shown} записей из ${params.total} — увеличь maxLines`);
  } else if (params.truncated) {
    parts.push(`обход оборван на depth ${params.depth} — увеличь maxLines или спроси list по папке`);
  }
  return parts.length > 0 ? `\n(${parts.join('; ')})` : '';
}

/** Путь для заголовка дерева: папка проекта или «проект». */
export function treeTitle(path: string | undefined, root: string | null): string {
  const folder = optionalString({ path }, 'path');
  if (!folder) return 'проект';
  return relative(folder, root) || folder;
}

export type { ToolOutcome };
