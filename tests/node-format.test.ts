import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatNode } from '../src/main/node/format';

/**
 * Форматирование файла инструментом Node-проекта — это про процессы, файловую
 * систему и stdin, поэтому проверяем его на настоящем проекте в temp-каталоге:
 * заглушки инструментов — обычные скрипты, которые печатают то, что получили.
 *
 * Так проверяется вся связка целиком: поиск скрипта по полю `bin`, запуск найденным
 * Node, аргументы для конкретного инструмента и чтение результата из stdout.
 */

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

/** Заглушка инструмента: печатает свои аргументы и текст из stdin в верхнем регистре. */
const ECHO_TOOL = [
  'const chunks = [];',
  "process.stdin.on('data', (chunk) => chunks.push(chunk));",
  "process.stdin.on('end', () => {",
  '  const args = JSON.stringify(process.argv.slice(2));',
  "  const text = Buffer.concat(chunks).toString('utf8').toUpperCase();",
  '  process.stdout.write(args + "\\n" + text);',
  '});',
].join('\n');

/** Проект в temp-каталоге: `package.json` с объявленными зависимостями и заглушки пакетов. */
async function makeProject(declared: readonly string[], installed: readonly { pkg: string; tool: string }[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-node-format-'));
  roots.push(root);

  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', dependencies: Object.fromEntries(declared.map((name) => [name, '^1.0.0'])) }),
  );

  for (const { pkg, tool } of installed) {
    const dir = path.join(root, 'node_modules', pkg);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: pkg, version: '1.0.0', bin: { [tool]: 'bin/cli.js' } }),
    );
    await fs.mkdir(path.join(dir, 'bin'), { recursive: true });
    await fs.writeFile(path.join(dir, 'bin', 'cli.js'), ECHO_TOOL);
  }

  return root;
}

/** Разложить ответ заглушки на аргументы и отформатированный текст. */
function split(text: string): { args: string[]; body: string } {
  const [first, ...rest] = text.split('\n');
  return { args: JSON.parse(first!) as string[], body: rest.join('\n') };
}

describe('formatNode', () => {
  it('запускает prettier проекта и отдаёт ему путь файла', async () => {
    const root = await makeProject([], [{ pkg: 'prettier', tool: 'prettier' }]);
    const result = await formatNode(root, '/p/src/a.ts', 'const a = 1;');

    expect(result.tool).toBe('prettier');
    const { args, body } = split(result.text);
    expect(args).toEqual(['--stdin-filepath', '/p/src/a.ts']);
    expect(body).toBe('CONST A = 1;');
  });

  it('biome зовётся своей командой — `format --stdin-file-path`', async () => {
    const root = await makeProject(['@biomejs/biome'], [{ pkg: '@biomejs/biome', tool: 'biome' }]);
    const result = await formatNode(root, '/p/src/a.js', 'const a = 1;');

    expect(result.tool).toBe('biome');
    expect(split(result.text).args).toEqual(['format', '--stdin-file-path', '/p/src/a.js']);
  });

  it('объявленный в проекте инструмент важнее установленного: biome идёт первым', async () => {
    const root = await makeProject(
      ['@biomejs/biome'],
      [
        { pkg: 'prettier', tool: 'prettier' },
        { pkg: '@biomejs/biome', tool: 'biome' },
      ],
    );

    expect((await formatNode(root, '/p/a.ts', 'const a = 1;')).tool).toBe('biome');
  });

  it('установленный, но не объявленный инструмент всё равно подхватывается', async () => {
    const root = await makeProject([], [{ pkg: '@biomejs/biome', tool: 'biome' }]);

    expect((await formatNode(root, '/p/a.ts', 'const a = 1;')).tool).toBe('biome');
  });

  it('инструментов нет — текст остаётся как был, и это не ошибка', async () => {
    const root = await makeProject([], []);

    expect(await formatNode(root, '/p/a.ts', 'const a = 1;')).toEqual({ text: 'const a = 1;', tool: null });
  });

  it('пакет установлен, но скрипта из `bin` нет — считаем, что инструмента нет', async () => {
    const root = await makeProject([], [{ pkg: 'prettier', tool: 'prettier' }]);
    await fs.rm(path.join(root, 'node_modules', 'prettier', 'bin', 'cli.js'));

    expect((await formatNode(root, '/p/a.ts', 'const a = 1;')).tool).toBeNull();
  });
});
