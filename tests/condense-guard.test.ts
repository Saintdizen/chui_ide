import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTool, type ToolContext } from '../src/main/ai/agent-tools';
import { WorkspaceService } from '../src/main/workspace/workspace';
import { isCondenseMarker } from '../src/shared/context-fit';

const MARKER = '[применено: 57 стр. — текст в файле]';

describe('пометка сжатия в аргументе: отказ вместо порчи файла', () => {
  it('узнаёт пометку и не путает её с текстом о пометке', () => {
    expect(isCondenseMarker(MARKER)).toBe(true);
    expect(isCondenseMarker(`  ${MARKER}\n`)).toBe(true);
    // Обычный текст, даже упоминающий сжатие, — не пометка.
    expect(isCondenseMarker('export const a = 1;')).toBe(false);
    expect(isCondenseMarker(`${MARKER}\nещё строка`)).toBe(false);
  });

  it('create_file: файл не создаётся, ответ объясняет причину', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chui-marker-'));
    const ws = new WorkspaceService(() => undefined);
    await ws.open(dir);
    try {
      const ctx = { workspace: ws, signal: new AbortController().signal } as ToolContext;
      const target = join(dir, 'probe.txt');
      const r = await runTool(ctx, 'create_file', JSON.stringify({ path: target, contents: MARKER }));
      expect(r.ok).toBe(false);
      expect(r.summary).toContain('contents');
      expect(r.summary).toContain('Повтори вызов');
      // Главное: на диске ничего не появилось.
      expect(existsSync(target)).toBe(false);
    } finally {
      ws.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('edit: старый текст на месте, ответ — отказ', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chui-marker-'));
    const file = join(dir, 'probe.ts');
    writeFileSync(file, 'const a = 1;\n', 'utf8');
    const ws = new WorkspaceService(() => undefined);
    await ws.open(dir);
    try {
      const ctx = { workspace: ws, signal: new AbortController().signal } as ToolContext;
      const args = { edits: [{ path: file, edits: [{ oldText: 'const a = 1;', newText: MARKER }] }] };
      const r = await runTool(ctx, 'edit', JSON.stringify(args));
      expect(r.ok).toBe(false);
      // Путь назван вложенно: по нему видно, какая именно правка испорчена.
      expect(r.summary).toContain('edits[0].edits[0].newText');
      expect(readFileSync(file, 'utf8')).toBe('const a = 1;\n');
    } finally {
      ws.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('terminal: команда-пометка не выполняется', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chui-marker-'));
    const ws = new WorkspaceService(() => undefined);
    await ws.open(dir);
    try {
      const ctx = { workspace: ws, signal: new AbortController().signal } as ToolContext;
      const r = await runTool(ctx, 'terminal', JSON.stringify({ action: 'run', command: MARKER }));
      expect(r.ok).toBe(false);
      expect(r.summary).toContain('command');
    } finally {
      ws.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('пометка узнаётся в старой и новой записи', () => {
  it('обе формы — пометка, обычный текст — нет', () => {
    expect(isCondenseMarker('[применено: 12 стр. — текст в файле]')).toBe(true);
    expect(isCondenseMarker('[применено: 12 стр. — текст в файле, не копировать]')).toBe(true);
    expect(isCondenseMarker('const a = 1;\n[применено: 12 стр.]')).toBe(false);
    expect(isCondenseMarker(42)).toBe(false);
  });
});
