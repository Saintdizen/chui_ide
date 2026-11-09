import { it } from 'vitest';
import { runTool, type ToolContext } from '../src/main/ai/agent-tools';
import { WorkspaceService } from '../src/main/workspace/workspace';

it('zz12', async () => {
  const ws = new WorkspaceService(() => undefined);
  await ws.open('/home/dethmond/PROJECTS/GITHUB/chui_ide');
  for (const q of ['formatCodeSearch', 'rankSnippets', 'trimOutput']) {
    const snip = await runTool({ workspace: ws } as unknown as ToolContext, 'search', JSON.stringify({ action: 'code', query: q, snippets: true }));
    console.log('Q', q, '|', snip.summary, 'симв', String(snip.detail).length);
  }
  const one = await runTool({ workspace: ws } as unknown as ToolContext, 'search', JSON.stringify({ action: 'code', query: 'rankSnippets', snippets: true }));
  console.log(String(one.detail).slice(0, 800));
});
