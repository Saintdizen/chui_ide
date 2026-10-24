import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { failureText, runTool, STEP_OUTPUT_CHARS, type ToolContext } from '../src/main/ai/agent-tools';
import { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Бюджет вывода на шаг.
 *
 * Предел на отдельный вызов эту задачу не решает: агент читает по три файла за
 * шаг, каждый честно укладывается в свой предел — и шаг приносит в контекст втрое
 * больше, чем стоит один вызов. Обрезка истории срабатывает уже следующим шагом и выбрасывает
 * ходы целиком: работа сделана, а результата в контексте нет.
 *
 * Поэтому шаг платит из общего бюджета, а исчерпанное называется вслух: модель
 * должна знать, что видит не весь текст, и что остальное лежит в файле.
 */

let dir: string;
let workspace: WorkspaceService;
let big: string;

/**
 * Файл на 400 длинных строк: одного чтения хватает, чтобы упереться в бюджет шага.
 * Строк ровно столько, чтобы файл ещё читался целиком (длиннее — отдаётся голова
 * и оглавление, см. `WHOLE_FILE_MAX_LINES`), а символов хватало на 80 000.
 */
const LINES = 400;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-step-budget-'));
  big = path.join(dir, 'big.txt');
  const filler = 'содержимое для веса '.repeat(20);
  const rows = Array.from({ length: LINES }, (_, index) => `строка ${index + 1} — ${filler}`);
  await fs.writeFile(big, rows.join('\n'), 'utf8');
  workspace = new WorkspaceService(() => undefined);
  await workspace.open(dir);
});

afterEach(async () => {
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

const readWhole = (ctx: ToolContext) => runTool(ctx, 'read', JSON.stringify({ path: big }));

describe('бюджет вывода на шаг', () => {
  it('без бюджета поведение прежнее: действует только предел на вызов', async () => {
    const ctx: ToolContext = { workspace };
    const outcome = await readWhole(ctx);
    expect(outcome.ok).toBe(true);
    // Файл в 400 длинных строк — около 170 000 символов, предел на вызов его режет.
    expect(String(outcome.detail ?? '').length).toBeLessThanOrEqual(46_000);
    expect(String(outcome.detail ?? '')).toContain('вывод обрезан');
  });

  it('первое чтение забирает бюджет, второе получает меньше и говорит об этом', async () => {
    const budget = { left: STEP_OUTPUT_CHARS };
    const first = await readWhole({ workspace, stepBudget: budget });
    expect(first.ok).toBe(true);
    // Бюджет шага — потолок: одно чтение не может забрать больше.
    expect(String(first.detail ?? '').length).toBeLessThanOrEqual(STEP_OUTPUT_CHARS + 200);
    expect(budget.left).toBeLessThan(STEP_OUTPUT_CHARS);

    const second = await readWhole({ workspace, stepBudget: budget });
    expect(second.ok).toBe(true);
    const detail = String(second.detail ?? '');
    // Бюджет исчерпан — второе чтение короткое и прямо об этом говорит.
    expect(detail.length).toBeLessThan(String(first.detail ?? '').length);
    expect(detail).toContain('бюджет вывода на шаг исчерпан');
    expect(budget.left).toBe(0);
  });

  it('минимум на вызов остаётся: пустого ответа не бывает', async () => {
    // Бюджет уже израсходован (например, командой с большим логом).
    const budget = { left: 0 };
    const outcome = await readWhole({ workspace, stepBudget: budget });
    expect(outcome.ok).toBe(true);
    const detail = String(outcome.detail ?? '');
    expect(detail.length).toBeGreaterThan(500);
    expect(detail).toContain('бюджет вывода на шаг исчерпан');
  });

  it('маленький результат бюджет не тратит зря и не обрезается', async () => {
    const budget = { left: STEP_OUTPUT_CHARS };
    const small = path.join(dir, 'small.txt');
    await fs.writeFile(small, 'одна строка\n', 'utf8');
    const outcome = await runTool({ workspace, stepBudget: budget }, 'read', JSON.stringify({ path: small }));
    expect(outcome.detail).toBe('одна строка\n');
    // Списано ровно столько, сколько отдано.
    expect(budget.left).toBe(STEP_OUTPUT_CHARS - 'одна строка\n'.length);
  });
});

describe('эхо команды в ответе', () => {
  it('многострочная команда не возвращается целиком', async () => {
    // Живой прогон: heredoc на две тысячи символов приходил обратно целиком —
    // 34% всех символов в ответах terminal оказались эхом того, что модель уже
    // написала в вызове.
    const workspace = new WorkspaceService(() => undefined);
    await workspace.open(dir);
    try {
      const ctx = {
        workspace,
        signal: new AbortController().signal,
        confirmCommand: async () => true,
      } as ToolContext;
      const command = ["cat > /dev/null <<'EOF'", 'строка один', 'строка два', 'EOF'].join('\n');
      const out = await runTool(ctx, 'terminal', JSON.stringify({ action: 'run', command }));
      const detail = out.detail ?? out.summary ?? '';
      expect(detail).toContain('команда из 4 строк');
      expect(detail).not.toContain('строка два');
    } finally {
      workspace.dispose();
    }
  }, 60_000);

  it('длинная команда в ошибке говорит, что делать', async () => {
    const workspace = new WorkspaceService(() => undefined);
    await workspace.open(dir);
    try {
      const ctx = {
        workspace,
        signal: new AbortController().signal,
        confirmCommand: async () => true,
      } as ToolContext;
      // Предел команды — 4 000 символов (было 2 000): перепись отказов показала,
      // что длинные `node -e` упирались в него и тратили шаг.
      const long = `echo ${'x'.repeat(4100)}`;
      const out = await runTool(ctx, 'terminal', JSON.stringify({ action: 'run', command: long }));
      // Пять шагов потеряно на heredoc в живом прогоне: ошибка обязана называть выход.
      expect(out.summary).toContain('`file` (action create)');
    } finally {
      workspace.dispose();
    }
  }, 60_000);
});

describe('отказ инструмента', () => {
  it('совет из detail доходит до модели, а не выбрасывается', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-fail-text-'));
    await fs.writeFile(path.join(dir, 'logo.bin'), Buffer.from([0, 1, 2, 0, 3]));
    const workspace = new WorkspaceService(() => undefined);
    await workspace.open(dir);
    try {
      const ctx = { workspace, signal: new AbortController().signal } as ToolContext;
      const outcome = await runTool(ctx, 'read', JSON.stringify({ path: path.join(dir, 'logo.bin') }));
      // Бинарный файл — отказ с советом в detail. Раньше в историю шёл только
      // summary («бинарный файл»), и модель шла угадывать, что с этим делать.
      expect(outcome.ok).toBe(false);
      expect(failureText(outcome)).toContain('list');
    } finally {
      workspace.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('что остаётся в истории от команды', () => {
  async function run(command: string) {
    const workspace = new WorkspaceService(() => undefined);
    await workspace.open(dir);
    try {
      const ctx = {
        workspace,
        signal: new AbortController().signal,
        confirmCommand: async () => true,
      } as ToolContext;
      return await runTool(ctx, 'terminal', JSON.stringify({ action: 'run', command }));
    } finally {
      workspace.dispose();
    }
  }

  it('отработавшая длинная команда отпускает свой текст', async () => {
    const outcome = await run(`echo ${'a'.repeat(500)}`);
    // applied — сигнал сжать аргументы в истории. Вывод и голова команды
    // остаются, поэтому переписать её можно и без тела.
    expect(outcome.ok).toBe(true);
    expect(outcome.applied).toBe(true);
  }, 60_000);

  it('упавшая команда остаётся целиком: по её тексту правят', async () => {
    // Только перенос строки, без `&&`/`||`: на Windows команда идёт в cmd.exe
    // через `/d /s /c`, и сложные конструкции там ведут себя иначе. Длина — из
    // кириллицы: строкой она остаётся той же в любой оболочке.
    const outcome = await run(`echo ${'начало '.repeat(80)}\necho конец ${'ещё '.repeat(60)}`);
    expect(outcome.ok).toBe(true);
    expect(outcome.applied).toBe(true);
  }, 60_000);

  it('короткая команда остаётся целиком', async () => {
    const outcome = await run('echo привет');
    expect(outcome.ok).toBe(true);
    expect(outcome.applied).toBeUndefined();
  }, 60_000);
});
