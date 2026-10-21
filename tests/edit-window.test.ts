import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ApplyEditsHostResult } from '../src/shared/api';
import { runTool, type ToolContext } from '../src/main/ai/agent-tools';
import { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Окно вокруг правки в ответе `edit`: без него модель проверяет результат отдельным
 * `read` — в замере живых бесед это 4,7 тыс. токенов на трёх беседах (6% всех чтений).
 * Строки вокруг правки стоят дешевле и отвечают на тот же вопрос: «легла ли правка».
 */
describe('окно вокруг правки', () => {
  const body = Array.from({ length: 12 }, (_, index) => `const v${index} = ${index};`).join('\n');

  it('после правки показывает строки вокруг, а не файл целиком', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chui-window-'));
    const file = join(dir, 'a.ts');
    writeFileSync(file, `${body}\n`, 'utf8');
    const workspace = new WorkspaceService(() => undefined);
    await workspace.open(dir);
    try {
      // Правку на диск кладёт редактор (renderer), здесь его роль играет эта функция.
      const applyPatches = async (): Promise<ApplyEditsHostResult> => {
        writeFileSync(file, `${body.replace('const v5 = 5;', 'const v5 = 55;')}\n`, 'utf8');
        return {
          rejected: false,
          result: { reports: [{ path: file, applied: 1, version: 1 }], failed: [] },
        } as unknown as ApplyEditsHostResult;
      };
      const ctx = { workspace, applyPatches, signal: new AbortController().signal } as ToolContext;
      const args = { edits: [{ path: file, edits: [{ oldText: 'const v5 = 5;', newText: 'const v5 = 55;' }] }] };
      const result = await runTool(ctx, 'edit', JSON.stringify(args));

      expect(result.ok).toBe(true);
      expect(result.detail).toContain('Окно вокруг правки');
      expect(result.detail).toContain('const v5 = 55;');
      // Начало и конец файла в окно не попадают: он про правку, а не про файл.
      expect(result.detail).not.toContain('const v0 = 0;');
      expect(result.detail).not.toContain('const v11 = 11;');
    } finally {
      workspace.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('провалившаяся правка окна не даёт: показывать нечего', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chui-window-'));
    const file = join(dir, 'a.ts');
    writeFileSync(file, `${body}\n`, 'utf8');
    const workspace = new WorkspaceService(() => undefined);
    await workspace.open(dir);
    try {
      const applyPatches = async (): Promise<ApplyEditsHostResult> =>
        ({
          rejected: false,
          result: { reports: [], failed: [{ path: file, reason: 'якорь не найден' }] },
        }) as unknown as ApplyEditsHostResult;
      const ctx = { workspace, applyPatches, signal: new AbortController().signal } as ToolContext;
      const args = { edits: [{ path: file, edits: [{ oldText: 'const v5 = 5;', newText: 'const v5 = 55;' }] }] };
      const result = await runTool(ctx, 'edit', JSON.stringify(args));

      expect(result.ok).toBe(false);
      expect(result.detail ?? '').not.toContain('Окно вокруг правки');
      expect(readFileSync(file, 'utf8')).toBe(`${body}\n`);
    } finally {
      workspace.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
