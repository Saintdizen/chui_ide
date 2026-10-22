import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runTool, type ToolContext } from '../src/main/ai/agent-tools';
import type { JobHandle, JobRegistry, JobSnapshot } from '../src/main/ai/jobs';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chui-job-output-'));
  dirs.push(dir);
  let text = '';
  let status: JobSnapshot['status'] = 'running';
  const snapshot = (): JobSnapshot => ({
    id: 'job-1',
    command: 'tests',
    status,
    startedAt: 0,
    code: status === 'failed' ? 1 : 0,
    signal: null,
    timedOut: false,
    total: text.length,
  });
  const job: JobHandle = {
    snapshot,
    read: (from = 0) => ({ data: text.slice(from), offset: text.length, snapshot: snapshot() }),
    stop: () => {},
  };
  const ctx = { spillDir: dir, jobs: { get: () => job } as unknown as JobRegistry } as ToolContext;
  return {
    append: (piece: string) => {
      text += piece;
    },
    finish: (failed = false) => {
      status = failed ? 'failed' : 'completed';
    },
    read: (from?: number) =>
      runTool(
        ctx,
        'terminal',
        JSON.stringify({ action: 'output', id: 'job-1', ...(from === undefined ? {} : { from }) }),
      ),
    dir,
  };
}

describe('фоновый вывод тестов', () => {
  it('сворачивает прошедшие, сохраняет ошибки и полную копию', async () => {
    const job = fixture();
    job.append('✓ first 1ms\n✓ second 2ms\nFAIL third\nexpected true\nTests 2 passed | 1 failed\n');
    job.finish(true);
    const out = await job.read();
    expect(out.ok).toBe(false);
    expect(out.detail).not.toContain('✓ first');
    expect(out.detail).toContain('прошло тестов: 2');
    expect(out.detail).toContain('FAIL third\nexpected true');
    expect(out.detail).toContain('Tests 2 passed | 1 failed');
    const files = fs.readdirSync(job.dir);
    expect(files).toHaveLength(1);
    expect(fs.readFileSync(path.join(job.dir, files[0]!), 'utf8')).toContain('✓ first');
    expect((await job.read()).detail).not.toContain('FAIL third');
    expect((await job.read(0)).detail).toContain('FAIL third');
  });

  it('склеивает строку между опросами и не повторяет прочитанное', async () => {
    const job = fixture();
    job.append('ready\n✓ par');
    const first = await job.read();
    expect(first.detail).toContain('ready');
    expect(first.detail).not.toContain('✓ par');
    expect(first.detail).toContain('offset: 6');
    job.append('tial 2ms\nTests 1 passed\n');
    job.finish();
    const second = await job.read();
    expect(second.detail).not.toContain('ready');
    expect(second.detail).toContain('прошло тестов: 1');
    expect(second.detail).toContain('Tests 1 passed');
  });

  it('не сворачивает произвольные галочки без итога тестов', async () => {
    const job = fixture();
    job.append('✓ installation complete\n');
    job.finish();
    expect((await job.read()).detail).toContain('✓ installation complete');
  });
});
