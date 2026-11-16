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

/**
 * Скрипт-пустышка: печатает то, что попросили, и выходит с заданным кодом.
 * Тело — POSIX-шелл. На Windows настоящего `/bin/sh` нет, поэтому tests ниже
 * там пропускаются (`skipIf`): проверять надо поиск команды, а не наличие шелла.
 * Файл помечаем исполняемым — на POSIX этого требует `X_OK` и spawn.
 */
const posixOnly = process.platform === 'win32';
const shell = posixOnly ? 'sh' : '/bin/sh';

async function script(dir: string, name: string, body: string): Promise<string> {
  const file = path.join(dir, name);
  await fs.writeFile(file, `${shell}\n${body}\n`, { mode: 0o755 });
  return file;
}

/**
 * Запуск скрипта-пустышки: имя и args — как из настроек LSP.
 * Скрипт POSIX-шелловый, поэтому на Windows через `sh` не пойдёт — такие tests
 * помечены `skipIf(posixOnly)`. Обёртку оставляю, чтобы не менять каждый test
 * по отдельности.
 */
function viaShell(file: string, args: string[] = ['--version']): { command: string; args: string[] } {
  return posixOnly ? { command: 'sh', args: [file, ...args] } : { command: file, args };
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
    expect(resolveCommand('pyright-langserver', dir, `${path.join(dir, 'nope')}${path.delimiter}${bin}`)).toBe(file);
  });

  // На POSIX «не исполняется» — это отсутствие бита X (файл 644).
  // На Windows бита нет, действие решает расширение: файл с расширением ищется
  // и без бита, а имя без `.exe`/`.cmd` — не команда. Поэтому на Windows
  // проверяем именно отсев по расширению, а не тот же самый `null`.
  it('неисполняемый файл — не находка: «есть» и «запустится» — разные вещи', async () => {
    const dir = await tmpDir();
    // Файл с известным расширением на Windows — существует и потому «находка»;
    // имя без `.exe`/`.cmd` — нет. На POSIX имя без расширения нормально, решает бит.
    const file = path.join(dir, posixOnly ? 'gopls.exe' : 'gopls');
    await fs.writeFile(file, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    if (posixOnly) {
      expect(resolveCommand(path.join(dir, 'gopls'), dir)).toBeNull();
    } else {
      expect(resolveCommand(file, dir)).toBeNull();
    }
  });

  it('пустая команда и пустой PATH — null, без исключений', async () => {
    const dir = await tmpDir();
    expect(resolveCommand('   ', dir)).toBeNull();
    expect(resolveCommand('gopls', dir, '')).toBeNull();
  });
});

describe('checkLspCommand', () => {
  // На Windows нет `/bin/sh`, а `resolved` для `sh`-обёртки и так был null.
  it.skipIf(posixOnly)('живая команда: ok, путь и версия из --version', async () => {
    const dir = await tmpDir();
    await script(dir, 'gopls', 'echo "gopls version v0.15.0"');
    const run = viaShell(path.join(dir, 'gopls'));
    const result = await checkLspCommand({ command: run.command, args: run.args, cwd: dir });
    expect(result.ok).toBe(true);
    expect(result.resolved).toBe(path.join(dir, 'gopls'));
    expect(result.version).toBe('gopls version v0.15.0');
    expect(result.error).toBe('');
  });

  it.skipIf(posixOnly)('версия пишется в stderr — всё равно версия', async () => {
    const dir = await tmpDir();
    await script(dir, 'gopls', 'echo "gopls v1" >&2');
    const run = viaShell(path.join(dir, 'gopls'));
    const result = await checkLspCommand({ command: run.command, args: run.args, cwd: dir });
    expect(result.ok).toBe(true);
    expect(result.version).toBe('gopls v1');
  });

  it.skipIf(posixOnly)('нашлась, но упала — код выхода в ответе, а не молчание', async () => {
    const dir = await tmpDir();
    await script(dir, 'gopls', 'echo "не хватает node" >&2; exit 3');
    const run = viaShell(path.join(dir, 'gopls'));
    const result = await checkLspCommand({ command: run.command, args: run.args, cwd: dir });
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

  it.skipIf(posixOnly)('аргументы из настроек идут вместо --version', async () => {
    const dir = await tmpDir();
    await script(dir, 'echoer', 'echo "$@"');
    const run = viaShell(path.join(dir, 'echoer'), ['--stdio', '--verbose']);
    const result = await checkLspCommand({ command: run.command, args: run.args, cwd: dir });
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
