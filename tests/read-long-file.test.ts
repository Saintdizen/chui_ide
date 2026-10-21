import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runTool, type SymbolSearch, type ToolContext } from '../src/main/ai/agent-tools';
import { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Чтение длинного файла без диапазона.
 *
 * Раньше оно отдавало первые 60 000 символов — около 15 000 токенов вслепую: конец
 * файла всё равно не виден, а следующие куски модель просила наугад. Теперь
 * длинный файл читается головой (120 строк) и оглавлением объявлений, а в конце
 * сказано, с какой строки продолжать.
 */

let dir: string;
let workspace: WorkspaceService;
let big: string;

const LINES = 900;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-long-file-'));
  big = path.join(dir, 'app.ts');
  const rows = Array.from({ length: LINES }, (_, index) => `const value${index + 1} = ${index + 1};`);
  await fs.writeFile(big, rows.join('\n'), 'utf8');
  workspace = new WorkspaceService(() => undefined);
  await workspace.open(dir);
});

afterEach(async () => {
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

/** Языковой сервер-заглушка: оглавление из двух объявлений. */
const symbols: SymbolSearch = {
  projectSymbols: async () => [],
  languageFor: () => 'typescript',
  outline: async () => [
    { name: 'value1', kind: 'константа', line: 1, endLine: 1, children: [] },
    { name: 'value500', kind: 'константа', line: 500, endLine: 500, children: [] },
  ],
};

const read = (ctx: ToolContext) => runTool(ctx, 'read', JSON.stringify({ path: big }));

describe('read длинного файла', () => {
  it('отдаёт голову, а не первые 60 000 символов', async () => {
    const outcome = await read({ workspace });
    const detail = String(outcome.detail ?? '');
    expect(outcome.ok).toBe(true);
    expect(detail).toContain('1 | const value1');
    // Голова — 120 строк, а не тысяча с лишним.
    expect(detail).toContain('120 | const value120');
    expect(detail).not.toContain('121 | const value121');
  });

  it('говорит, сколько строк всего и с какой продолжать', async () => {
    const outcome = await read({ workspace });
    const detail = String(outcome.detail ?? '');
    expect(detail).toContain(`строк всего ${LINES}`);
    expect(detail).toContain('startLine с 121');
    expect(outcome.summary).toContain(`показаны первые 120`);
  });

  it('оглавление от языкового сервера добавляется, когда он есть', async () => {
    const outcome = await read({ workspace, symbols });
    const detail = String(outcome.detail ?? '');
    expect(detail).toContain('Оглавление');
    expect(detail).toContain('value500');
  });

  it('без языкового сервера чтение работает и без оглавления', async () => {
    const outcome = await read({ workspace, symbols: { projectSymbols: async () => [] } });
    const detail = String(outcome.detail ?? '');
    expect(outcome.ok).toBe(true);
    expect(detail).toContain('1 | const value1');
    expect(detail).not.toContain('Оглавление');
    expect(detail).toContain('lsp (action: outline)');
  });

  it('прочитанными считаются только показанные строки', async () => {
    const outcome = await read({ workspace });
    // Иначе следующий запрос «с 121 до конца» считался бы уже прочитанным.
    expect(outcome.read).toEqual({ path: big, from: 1, to: 120 });
  });

  it('файл длиннее 160 строк читается головой, а не целиком', async () => {
    // Порог WHOLE_FILE_MAX_LINES снижен с 250 до 160: файл на 300 строк раньше
    // отдавался целиком (~2600 токенов), теперь — голова и оглавление.
    const medium = path.join(dir, 'medium.ts');
    const rows = Array.from({ length: 300 }, (_, index) => `const row${index + 1} = ${index + 1};`);
    await fs.writeFile(medium, rows.join('\n'), 'utf8');
    const outcome = await runTool({ workspace }, 'read', JSON.stringify({ path: medium }));
    const detail = String(outcome.detail ?? '');
    expect(detail).toContain('1 | const row1');
    expect(detail).toContain('120 | const row120');
    expect(detail).not.toContain('121 | const row121');
    expect(detail).toContain('startLine с 121');
    expect(outcome.read).toEqual({ path: medium, from: 1, to: 120 });
  });

  it('файл до 160 строк по-прежнему читается целиком', async () => {
    const medium = path.join(dir, 'small.ts');
    const rows = Array.from({ length: 160 }, (_, index) => `const row${index + 1} = ${index + 1};`);
    await fs.writeFile(medium, rows.join('\n'), 'utf8');
    const outcome = await runTool({ workspace }, 'read', JSON.stringify({ path: medium }));
    const detail = String(outcome.detail ?? '');
    // Целый файл отдаётся без номеров строк: нумерация — 5 символов на строку, а
    // нужна она только диапазонам (там по номерам просят продолжение).
    expect(detail).toContain('const row160 = 160;');
  });

  it('короткий файл по-прежнему читается целиком', async () => {
    const small = path.join(dir, 'small.txt');
    await fs.writeFile(small, 'первая\nвторая\n', 'utf8');
    const outcome = await runTool({ workspace }, 'read', JSON.stringify({ path: small }));
    expect(outcome.detail).toBe('первая\nвторая\n');
    expect(outcome.read).toEqual({ path: small, from: 1, to: 3 });
  });
});
