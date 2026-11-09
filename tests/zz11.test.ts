import { it } from 'vitest';
import { runTool, type ToolContext } from '../src/main/ai/agent-tools';
import { WorkspaceService } from '../src/main/workspace/workspace';

it('zz11', async () => {
  const ws = new WorkspaceService(() => undefined);
  await ws.open('/home/dethmond/PROJECTS/GITHUB/chui_ide');
  const code = await runTool({ workspace: ws } as unknown as ToolContext, 'search', JSON.stringify({ action: 'code', query: 'safePath' }));
  const snip = await runTool({ workspace: ws } as unknown as ToolContext, 'search', JSON.stringify({ action: 'code', query: 'safePath', snippets: true }));
  console.log('CODE ', code.summary, 'симв', String(code.detail).length);
  console.log('SNIP ', snip.summary, 'симв', String(snip.detail).length);
  console.log(String(snip.detail).slice(0, 700));
});
