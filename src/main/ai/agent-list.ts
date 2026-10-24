/**
 * `list` — дерево папки глазами модели.
 *
 * Отдаём одну страницу с пометкой «ещё N записей», а не весь каталог: агент
 * смотрит, где что лежит, и за подробностями идёт в `search`/`read`.
 */
import type { WorkspaceService } from '../workspace/workspace';
import { describe, relative } from './agent-terminal';
import { optionalString } from './tool-args';
import { MAX_DIR_ENTRIES } from './tool-rules';
import type { ToolOutcome } from './tool-context';

export async function listDir(workspace: WorkspaceService, args: Record<string, unknown>): Promise<ToolOutcome> {
  const requested = optionalString(args, 'path') ?? workspace.rootPath();
  if (!requested) return { ok: false, summary: 'Проект не открыт' };

  const root = workspace.rootPath();
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
