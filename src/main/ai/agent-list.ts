/**
 * `list` — дерево папки глазами модели.
 *
 * Отдаём одну страницу с пометкой «ещё N записей», а не весь каталог: агент
 * смотрит, где что лежит, и за подробностями идёт в `search`/`read`.
 */
import type { WorkspaceService } from '../workspace/workspace';
import { describe, relative } from './agent-terminal';
import { optionalInteger, optionalString } from './tool-args';
import { collectTree, treeDepth, treeLines, treeMaxLines, treeTail, treeTitle } from './agent-tree';
import { MAX_DIR_ENTRIES } from './tool-rules';
import type { ToolOutcome } from './tool-context';

export async function listDir(workspace: WorkspaceService, args: Record<string, unknown>): Promise<ToolOutcome> {
  const requested = optionalString(args, 'path') ?? workspace.rootPath();
  if (!requested) return { ok: false, summary: 'Проект не открыт' };

  const root = workspace.rootPath();
  // Глубина больше одного уровня — дерево (п.63). Плоский список остаётся
  // умолчанием: чаще нужна одна папка, и дерево на каждый вызов — это дорого.
  if (treeDepthArg(args)) return await listTree(workspace, requested, args);
  const entries = await workspace.readDir(requested);
  const shown = entries.slice(0, MAX_DIR_ENTRIES);
  const lines = shown.map((entry) => `${describe(entry, root)}`);
  if (entries.length > shown.length) lines.push(`… ещё ${entries.length - shown.length} записей`);

  return {
    ok: true,
    summary: `${relative(requested, root)}: ${entries.length} записей`,
    detail: lines.length ? lines.join('\n') : '(пусто)',
  };
}

/**
 * Дерево папки: `depth` уровней вглубь, потолок `maxLines` строк.
 *
 * Обход в ширину: сначала соседи, потом внуки — если потолок оборвёт обход, то
 * лучше оборвать дальнее, чем спрятать соседа.
 */
async function listTree(
  workspace: WorkspaceService,
  requested: string,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const root = workspace.rootPath();
  const depth = treeDepth(args);
  const maxLines = treeMaxLines(args);
  const { nodes, truncated } = await collectTree(workspace, requested, {
    depth,
    maxEntries: maxLines,
  });
  const { text, shown, total } = treeLines(nodes, root, maxLines);
  const title = treeTitle(requested, root);
  const tail = treeTail({ truncated, total, shown, depth, path: requested });
  return {
    ok: true,
    summary: `${title}: дерево, ${total} записей в ${depth} уровня${tail ? ' (обрезано)' : ''}`,
    detail: (text || '(пусто)') + tail,
  };
}

/** Просили ли глубину явно: без неё остаётся прежний плоский список. */
function treeDepthArg(args: Record<string, unknown>): boolean {
  // Разбираем тем же optionalInteger, что и treeDepth, иначе модель прислала бы
  // "2" строкой — ветка дерева не выбралась бы, а глубина тихо осталась 1.
  const depth = optionalInteger(args, 'depth');
  return depth !== undefined && depth > 1;
}
