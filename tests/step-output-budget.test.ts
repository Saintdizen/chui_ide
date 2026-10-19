import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runTool, STEP_OUTPUT_CHARS, type ToolContext } from '../src/main/ai/agent-tools';
import { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Бюджет вывода на шаг.
 *
 * Предел на отдельный вызов эту задачу не решает: агент читает по три файла за
 * шаг, каждый честно укладывается в свои 60 000 символов — и шаг приносит в
 * контекст 180 000. Обрезка истории срабатывает уже следующим шагом и выбрасывает
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

const readWhole = (ctx: ToolContext) => runTool(ctx, 'read_file', JSON.stringify({ path: big }));

describe('бюджет вывода на шаг', () => {
  it('без бюджета поведение прежнее: действует только предел на вызов', async () => {
    const ctx: ToolContext = { workspace };
    const outcome = await readWhole(ctx);
    expect(outcome.ok).toBe(true);
    // Файл в 4 000 строк — около 150 000 символов, предел на вызов его режет.
    expect(String(outcome.detail ?? '').length).toBeLessThanOrEqual(61_000);
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
    const outcome = await runTool({ workspace, stepBudget: budget }, 'read_file', JSON.stringify({ path: small }));
    expect(outcome.detail).toBe('одна строка\n');
    // Списано ровно столько, сколько отдано.
    expect(budget.left).toBe(STEP_OUTPUT_CHARS - 'одна строка\n'.length);
  });
});
