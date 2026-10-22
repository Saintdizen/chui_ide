import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runTool, searchFallbacks, type ToolContext } from '../src/main/ai/agent-tools';
import { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Запасные запросы поиска.
 *
 * Поиск без совпадений — самый частый его исход: перепись 43 вызовов дала медиану
 * 0 попаданий, а максимум — 18. Голое «Совпадений нет» агент лечит повтором того
 * же поиска другими словами, и это целый шаг. Поэтому промах по регистру, regex
 * или стилю имени разбирается на месте: один-два ослабленных запроса дешевле шага.
 */

let dir: string;
let workspace: WorkspaceService;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-fallback-'));
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  // Имя в коде — camelCase, а спросить его могут snake_case: точной подстроки нет.
  await fs.writeFile(path.join(dir, 'src/config.ts'), 'export const readTextFile = 1;\n', 'utf8');
  await fs.writeFile(path.join(dir, 'src/other.ts'), 'const marker = 2;\n', 'utf8');
  workspace = new WorkspaceService(() => undefined);
  await workspace.open(dir);
});

afterEach(async () => {
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

const search = (args: Record<string, unknown>) =>
  runTool({ workspace } as unknown as ToolContext, 'search', JSON.stringify(args));

describe('searchFallbacks: что пробовать после пустого поиска', () => {
  it('обычный запрос ослаблять нечем', () => {
    expect(searchFallbacks('marker', { isRegex: false, caseSensitive: false })).toEqual([]);
  });

  it('регистр — первое, что снимается', () => {
    const variants = searchFallbacks('Marker', { isRegex: false, caseSensitive: true });
    expect(variants).toHaveLength(1);
    expect(variants[0]!.values).toEqual({ caseSensitive: false });
    expect(variants[0]!.note).toContain('регистра');
  });

  it('regex пробуется как обычный текст', () => {
    const variants = searchFallbacks('marker\\s+=\\s+1', { isRegex: true, caseSensitive: false });
    expect(variants.map((variant) => variant.values)).toContainEqual({ isRegex: false });
  });

  it('составное имя ищется по самой длинной части', () => {
    const variants = searchFallbacks('read_text_file', { isRegex: false, caseSensitive: false });
    expect(variants).toHaveLength(1);
    expect(['read', 'text', 'file']).toContain(variants[0]!.values.query);
    expect(variants[0]!.values.caseSensitive).toBe(false);
    // Подпись говорит, что совпадение не точное: иначе найденное примут за ответ.
    expect(variants[0]!.note).toContain('не точное');
  });

  it('camelCase и путь в маске разбираются на слова', () => {
    expect(searchFallbacks('readTextFile', { isRegex: false, caseSensitive: false })[0]!.values.query).toBe('read');
    expect(searchFallbacks('src/config.ts', { isRegex: false, caseSensitive: false })[0]!.values.query).toBe('config');
  });

  it('за один промах — не больше двух запросов', () => {
    const variants = searchFallbacks('readTextFile', { isRegex: true, caseSensitive: true });
    expect(variants).toHaveLength(2);
  });
});

describe('search: промах разбирается на месте', () => {
  it('snake_case находит camelCase и говорит, по какой части', async () => {
    const outcome = await search({ query: 'read_text_file' });

    expect(outcome.ok).toBe(true);
    expect(String(outcome.detail)).toContain('config.ts');
    expect(String(outcome.detail)).toContain('не точное совпадение');
  });

  it('промах по регистру при caseSensitive снимается сам', async () => {
    const outcome = await search({ query: 'ReadTextFile', caseSensitive: true });

    expect(outcome.ok).toBe(true);
    expect(String(outcome.detail)).toContain('config.ts');
    expect(String(outcome.detail)).toContain('без учёта регистра');
  });

  it('точное совпадение остаётся точным: подписи нет', async () => {
    const outcome = await search({ query: 'readTextFile' });

    expect(String(outcome.detail)).toContain('config.ts');
    expect(String(outcome.detail)).not.toContain('не точное');
  });

  it('пусто и после ослаблений — в ответе названо, что перебрали', async () => {
    // Иначе агент повторяет ровно те же пробы — и теряет шаг.
    const outcome = await search({ query: 'read_text_file_which_is_absent', caseSensitive: true });

    expect(outcome.ok).toBe(true);
    const detail = String(outcome.detail);
    expect(detail).toContain('Совпадений нет');
    expect(detail).toContain('Уже проверено');
  });
});
