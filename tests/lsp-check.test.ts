import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkLspCommand, firstLine, resolveCommand } from '../src/main/lsp/check';

/**
 * «Проверить» в окне настроек LSP.
 *
 * Кнопка нужна из-за главного провала настройки сервера: человек пишет
 * команду, сохраняет, а «сервер не найден» всплывает потом и не говорит почему.
 * Здесь сторожится, что проверка различает три исхода: нашлась и
 * ответила, нашлась и упала, не нашлась вообще — и каждый говорит это словами.
 */

const dirs: string[] = [];

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-lsp-check-'));
  dirs.push(dir);
  return dir;
}

/** Скрипт-пустышка: печатает то, что попросили, и выходит с заданным кодом. */
async function script(dir: string, name: string, body: string): Promise<string> {
  const file = path.join(dir, name);
  await fs.writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('resolveCommand', () => {
  it('находит файл по абсолютному пути', async () => {
    const dir = await tmpDir();
    const file = await script(dir, 'gopls', 'echo go version go1.22');
    expect(resolveCommand(file, dir)).toBe(file);
  });

  it('относительный путь считается от корня проекта', async () => {
    const dir = await tmpDir();
    await fs.mkdir(path.join(dir, 'node_modules/.bin'), { recursive: true });
    const file = await script(path.join(dir, 'node_modules/.bin'), 'vscode-langservers-extracted', 'exit 0');
    expect(resolveCommand('./node_modules/.bin/vscode-langservers-extracted', dir)).toBe(file);
  });

  it('голое имя ищется по PATH, а не только в корне', async () => {
    const dir = await tmpDir();
    const bin = path.join(dir, 'bin');
    await fs.mkdir(bin, { recursive: true });
    const file = await script(bin, 'pyright-langserver', 'exit 0');
    expect(resolveCommand('pyright-langserver', dir, `${path.join(dir, 'nope')}:${bin}`)).toBe(file);
  });

  it('неисполняемый файл — не находка: «есть» и «запустится» — разные вещи', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'gopls');
    await fs.writeFile(file, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    expect(resolveCommand(file, dir)).toBeNull();
  });

  it('пустая команда и пустой PATH — null, без исключений', async () => {
    const dir = await tmpDir();
    expect(resolveCommand('   ', dir)).toBeNull();
    expect(resolveCommand('gopls', dir, '')).toBeNull();
  });
});

describe('checkLspCommand', () => {
  it('живая команда: ok, путь и версия из --version', async () => {
    const dir = await tmpDir();
    await script(dir, 'gopls', 'echo "gopls version v0.15.0"');
    const result = await checkLspCommand({ command: './gopls', cwd: dir });
    expect(result.ok).toBe(true);
    expect(result.resolved).toBe(path.join(dir, 'gopls'));
    expect(result.version).toBe('gopls version v0.15.0');
    expect(result.error).toBe('');
  });

  it('версия пишется в stderr — всё равно версия', async () => {
    const dir = await tmpDir();
    await script(dir, 'gopls', 'echo "gopls v1" >&2');
    const result = await checkLspCommand({ command: './gopls', cwd: dir });
    expect(result.ok).toBe(true);
    expect(result.version).toBe('gopls v1');
  });

  it('нашлась, но упала — код выхода в ответе, а не молчание', async () => {
    const dir = await tmpDir();
    await script(dir, 'gopls', 'echo "не хватает node" >&2; exit 3');
    const result = await checkLspCommand({ command: './gopls', cwd: dir });
    expect(result.ok).toBe(false);
    expect(result.resolved).toBe(path.join(dir, 'gopls'));
    expect(result.error).toContain('кодом 3');
    expect(result.error).toContain('не хватает node');
  });

  it('не нашлась — в ответе названа команда, которую искали', async () => {
    const dir = await tmpDir();
    const result = await checkLspCommand({ command: './нет-такой', cwd: dir });
    expect(result.ok).toBe(false);
    expect(result.resolved).toBe('');
    expect(result.error).toContain('нет-такой');
    expect(result.error).toContain('не найдена');
  });

  it('пустая команда не запускает ничего и говорит прямо', async () => {
    const dir = await tmpDir();
    const result = await checkLspCommand({ command: '  ', cwd: dir });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('(пусто)');
  });

  it('аргументы из настроек идут вместо --version', async () => {
    const dir = await tmpDir();
    await script(dir, 'echoer', 'echo "$@"');
    const result = await checkLspCommand({ command: './echoer', args: ['--stdio', '--verbose'], cwd: dir });
    expect(result.ok).toBe(true);
    expect(result.version).toBe('--stdio --verbose');
  });
});

describe('firstLine', () => {
  it('берёт первую непустую строку', () => {
    expect(firstLine('\n\n  v1.2.3 \nещё')).toBe('v1.2.3');
  });

  it('длинная строка обрезается — в подсказке ей не место', () => {
    const line = firstLine('x'.repeat(500));
    expect(line.length).toBe(201);
    expect(line.endsWith('…')).toBe(true);
  });

  it('пусто — пустая строка, а не undefined', () => {
    expect(firstLine('   \n\t')).toBe('');
  });
});
