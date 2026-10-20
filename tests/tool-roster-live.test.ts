import { describe, expect, it } from 'vitest';
import { runTool, type ToolContext } from '../src/main/ai/agent-tools';
import { WorkspaceService } from '../src/main/workspace/workspace';
import { estimateTextTokens } from '../src/shared/context-fit';
import { AGENT_TOOLS, toOpenAiTools } from '../src/shared/tools';
import { isRosterTool, presetToolNames, toolPresetNote } from '../src/shared/tool-presets';

describe('скрытое по имени: привычка не должна дорожать', () => {
  const offered = () => {
    const names = presetToolNames('auto');
    return AGENT_TOOLS.filter((spec) => names?.has(spec.name));
  };

  it('в запросе нет схемы project_map, но имя — в ростере', () => {
    const wire = toOpenAiTools(offered()).map((tool) => tool.function.name);
    expect(wire).not.toContain('project_map');
    expect(toolPresetNote('auto')).toContain('project_map()');
  });

  it('подсказка обещает только то, что механизм делает', () => {
    const note = toolPresetNote('auto');
    // Из ростера инструмент выполняется, но в набор не возвращается: обещать
    // «подключится» — значит посулить схему, которой на следующем шаге не будет.
    expect(note).not.toContain('подключится');
    expect(note).toContain('выполнится');
    expect(estimateTextTokens(note)).toBeLessThan(300);
  });

  it('вызов по имени выполняется и набор не растёт', async () => {
    const before = presetToolNames('auto')?.size ?? 0;
    const ws = new WorkspaceService(() => undefined);
    await ws.open(process.cwd());
    try {
      const ctx = { workspace: ws, signal: new AbortController().signal } as ToolContext;
      const r = await runTool(ctx, 'project_map', JSON.stringify({}));
      expect(r.ok).toBe(true);
      // Из ростера: исполняется, но остаётся скрытым — схема не возвращается.
      expect(isRosterTool('auto', 'project_map')).toBe(true);
      expect(presetToolNames('auto')?.size ?? 0).toBe(before);
    } finally {
      ws.dispose();
    }
  }, 60_000);
});
