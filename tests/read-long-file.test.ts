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
 * длинный файл читается головой (200 строк) и оглавлением объявлений, а в конце
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

const read = (ctx: ToolContext) => runTool(ctx, 'read_file', JSON.stringify({ path: big }));

describe('read_file длинного файла', () => {
  it('отдаёт голову, а не первые 60 000 символов', async () => {
    const outcome = await read({ workspace });
    const detail = String(outcome.detail ?? '');
    expect(outcome.ok).toBe(true);
    expect(detail).toContain('1 | const value1');
    // Голова — 200 строк, а не тысяча с лишним.
    expect(detail).toContain('200 | const value200');
    expect(detail).not.toContain('201 | const value201');
  });

  it('говорит, сколько строк всего и с какой продолжать', async () => {
    const outcome = await read({ workspace });
    const detail = String(outcome.detail ?? '');
    expect(detail).toContain(`строк всего ${LINES}`);
    expect(detail).toContain('startLine с 201');
    expect(outcome.summary).toContain(`показаны первые 200`);
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
    expect(detail).toContain('file_outline');
  });

  it('прочитанными считаются только показанные строки', async () => {
    const outcome = await read({ workspace });
    // Иначе следующий запрос «с 201 до конца» считался бы уже прочитанным.
    expect(outcome.read).toEqual({ path: big, from: 1, to: 200 });
  });

  it('короткий файл по-прежнему читается целиком', async () => {
    const small = path.join(dir, 'small.txt');
    await fs.writeFile(small, 'первая\nвторая\n', 'utf8');
    const outcome = await runTool({ workspace }, 'read_file', JSON.stringify({ path: small }));
    expect(outcome.detail).toBe('первая\nвторая\n');
    expect(outcome.read).toEqual({ path: small, from: 1, to: 3 });
  });
});
