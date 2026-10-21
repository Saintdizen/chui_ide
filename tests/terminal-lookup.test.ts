import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runTool, type SandboxRunner, type ToolContext } from '../src/main/ai/agent-tools';
import { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Чтение через шелл — 43% вызовов `terminal` в переписи (TASKS.md, п.43).
 * `cat`, `head -n N`, `sed -n 'A,Bp'`, `grep` и `ls` теперь разбираются и
 * выполняются структурными `read`/`search`/`list`: с номерами строк, с потолком
 * вывода и без запуска шелла. Всё, что не разобралось, идёт в шелл как раньше.
 */

let dir: string;
let workspace: WorkspaceService;

const LINES = 40;

/** Песочница-подставка: помнит, что и где просили выполнить. */
function sandbox(): SandboxRunner & { calls: { command: string; cwd: string }[] } {
  const calls: { command: string; cwd: string }[] = [];
  return {
    label: 'контейнер обрезка',
    available: true,
    run: async (command: string, cwd: string) => {
      calls.push({ command, cwd });
      return { code: 0, signal: null, output: 'шелл', truncated: false, timedOut: false };
    },
    calls,
  };
}

/** Контекст с подтверждением: путь через шелл его спрашивает, разбор — нет. */
function context(box: SandboxRunner, coveredReads?: ToolContext['coveredReads']): ToolContext {
  return {
    workspace,
    sandbox: box,
    coveredReads,
    confirmCommand: async () => true,
  } as unknown as ToolContext;
}

const run = (box: SandboxRunner, command: string) =>
  runTool(context(box), 'terminal', JSON.stringify({ action: 'run', command }));

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-lookup-'));
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  const rows = Array.from({ length: LINES }, (_, index) => `const row${index + 1} = ${index + 1};`);
  await fs.writeFile(path.join(dir, 'src/app.ts'), rows.join('\n'), 'utf8');
  await fs.writeFile(path.join(dir, 'src/note.md'), 'иголка в стоге\n', 'utf8');
  workspace = new WorkspaceService(() => undefined);
  await workspace.open(dir);
});

afterEach(async () => {
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('команда-читалка выполняется структурно', () => {
  it('cat файла — это read с номерами строк', async () => {
    const box = sandbox();
    const outcome = await run(box, 'cat src/app.ts');

    expect(box.calls).toEqual([]);
    expect(outcome.ok).toBe(true);
    // Файл короткий — `read` отдаёт его целиком и без номеров (номера только у
    // диапазона): `cat` получает ровно то же, что дал бы `read(path)`.
    expect(String(outcome.detail)).toContain('const row1 = 1;');
    expect(String(outcome.detail)).toContain(`const row${LINES} = ${LINES};`);
    expect(outcome.summary).toContain('cat → read');
  });

  it('sed -n «A,Bp» — это read диапазоном', async () => {
    const box = sandbox();
    const outcome = await run(box, "sed -n '3,5p' src/app.ts");

    expect(box.calls).toEqual([]);
    const detail = String(outcome.detail);
    expect(detail).toContain('3 | const row3 = 3;');
    expect(detail).toContain('5 | const row5 = 5;');
    expect(detail).not.toContain('6 | const row6 = 6;');
  });

  it('head -n N и head -N — это read с endLine', async () => {
    const box = sandbox();
    const spaced = await run(box, 'head -n 2 src/app.ts');
    const joined = await run(box, 'head -2 src/app.ts');

    expect(box.calls).toEqual([]);
    for (const outcome of [spaced, joined]) {
      expect(String(outcome.detail)).toContain('2 | const row2 = 2;');
      expect(String(outcome.detail)).not.toContain('3 | const row3 = 3;');
    }
  });

  it('grep — это search, а не шелл', async () => {
    const box = sandbox();
    const outcome = await run(box, 'grep -rn иголка src');

    expect(box.calls).toEqual([]);
    expect(outcome.ok).toBe(true);
    expect(String(outcome.detail)).toContain('note.md');
    expect(outcome.summary).toContain('grep → search');
  });

  it('ls — это list', async () => {
    const box = sandbox();
    const outcome = await run(box, 'ls -la src');

    expect(box.calls).toEqual([]);
    expect(outcome.ok).toBe(true);
    expect(String(outcome.detail)).toContain('app.ts');
    expect(String(outcome.detail)).toContain('note.md');
  });
});

describe('всё остальное по-прежнему идёт в шелл', () => {
  it('не команда-читалка', async () => {
    const box = sandbox();
    await run(box, 'npm test');

    expect(box.calls.length).toBe(1);
  });

  it('труба или перенаправление — это уже скрипт', async () => {
    for (const command of ['cat src/app.ts | head -1', 'grep иголка src > out.txt', 'cat a.ts && cat b.ts']) {
      const box = sandbox();
      await run(box, command);
      expect(box.calls.length, command).toBe(1);
    }
  });

  it('неизвестный флаг — не наш случай', async () => {
    const box = sandbox();
    await run(box, 'ls -R src');

    expect(box.calls.length).toBe(1);
  });
});

describe('читалка поверх уже прочитанного', () => {
  it('повторный cat того же файла — строка, а не вторая копия', async () => {
    const box = sandbox();
    const coveredReads = new Map<string, Array<{ from: number; to: number }>>();
    coveredReads.set(path.join(dir, 'src/app.ts'), [{ from: 1, to: LINES }]);
    const outcome = await runTool(
      context(box, coveredReads),
      'terminal',
      JSON.stringify({ action: 'run', command: 'cat src/app.ts' }),
    );
    expect(outcome.summary).toContain('уже прочитано');
    expect(String(outcome.detail)).toContain('уже есть выше в ветке');
    expect(String(outcome.detail)).not.toContain('const row1');
    expect(box.calls, 'шелл не понадобился').toEqual([]);
  });
});
