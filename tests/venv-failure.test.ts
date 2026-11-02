import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { conflictLines, createVenv, failureMessage, runCommand } from '../src/main/python/environments';
import { venvPythonPath, type VenvInstallPreset } from '../src/shared/python-env';
import type { VenvProgressPayload } from '../src/shared/api';

/**
 * Сообщение о сбое команды окружения. Смысл подсказок — назвать причину там, где
 * она неочевидна: на Debian/Ubuntu venv и pip вынесены в отдельный пакет, и без
 * подсказки человек видит лишь «No module named pip» и не знает, что делать.
 */
describe('failureMessage', () => {
  it('называет команду, аргументы, код выхода и последнюю строку', () => {
    const message = failureMessage('python3', ['-m', 'venv', '.venv'], 1, ['шум', 'boom']);
    expect(message).toContain('python3 -m venv .venv');
    expect(message).toContain('код выхода 1');
    expect(message).toContain('boom');
  });

  it('подсказывает про пакет python3.X-venv, если нет ensurepip', () => {
    const message = failureMessage('python3', ['-m', 'venv', '.venv'], 1, ['Error: ensurepip is not available']);
    expect(message).toContain('нет модуля venv');
    expect(message).toContain('python3.X-venv');
  });

  it('подсказывает про pip, если окружение создано без него', () => {
    const message = failureMessage('python', ['-m', 'pip', 'install', 'six'], 1, ['python: No module named pip']);
    expect(message).toContain('нет pip');
    expect(message).toContain('python3.X-venv');
  });

  it('на прочих сбоях добавляет только последнюю строку', () => {
    const message = failureMessage('pip', ['install', 'x'], 2, ['collecting', 'ERROR: no such package']);
    expect(message).toContain('ERROR: no such package');
    expect(message).not.toContain('python3.X-venv');
  });

  it('не падает без вывода вовсе', () => {
    expect(failureMessage('x', [], null, [])).toContain('код выхода null');
  });
});

/**
 * `pip install` не ищет несовместимость версий: успешная установка двух
 * взаимоисключающих пакетов печатает «Successfully installed», и молчит о
 * конфликте. Называет его только `pip check` — его вывод и разбираем.
 */
describe('conflictLines', () => {
  it('берёт строки с противоречиями как есть', () => {
    const lines = conflictLines('pkg-a 1.0 requires pkg-b<2, but you have pkg-b 2.1 which is incompatible.');
    expect(lines).toEqual(['pkg-a 1.0 requires pkg-b<2, but you have pkg-b 2.1 which is incompatible.']);
  });

  it('чистое окружение — пусто, а не «No broken requirements found»', () => {
    expect(conflictLines('No broken requirements found.')).toEqual([]);
  });

  it('сбой самого pip — не пустота, а названная причина', () => {
    expect(conflictLines('pip check не отработал: spawn ENOENT')).toEqual(['pip check не отработал: spawn ENOENT']);
  });
});

/**
 * `pip check` после установки: вызывается ли он вообще и что делает с кодом 1.
 *
 * Проверять это на сообщениях нельзя — там виден только разбор вывода. А вопрос
 * важный: сам по себе `pip install` о противоречиях молчит, и если проверка не
 * запустилась, человек читает «Готово» и живёт с несовместимыми версиями.
 *
 * Вместо настоящего питона подсовываем скрипт-заглушку через `options.base`: она
 * отвечает так же, как питон (`-m venv …`, `-m pip install …`, `-m pip check`).
 * Заглушка — `.js` под текущим node: шелл-скрипта здесь нет, а `sh` на Windows
 * не поможет.
 */
describe('createVenv зовёт pip check', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  });

  /**
   * Заглушка питона в каталоге `bin`: пишет вызовы в `calls.log`, а на `venv`
   * действительно создаёт интерпретатор (иначе createVenv скажет «не найден»).
   * Код `pip check` и её вывод задаёт переменные `FAKE_PIP_EXIT`/`FAKE_PIP_OUT`.
   * `FAKE_SOURCE` — текст заглушки: его createVenv кладёт в окружение как `python`.
   */
  async function fakePython(parent: string): Promise<{ base: string; source: string; calls: () => Promise<string[]> }> {
    const bin = path.join(parent, 'fakebin');
    await fs.mkdir(bin, { recursive: true });
    const script = path.join(bin, 'python-fake.js');
    const log = path.join(parent, 'calls.log');
    const source = `
const fs = require('node:fs');
const path = require('node:path');
const [mode, ...rest] = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, [mode, ...rest].join(' ') + '\\n');
if (mode === '-m' && rest[0] === 'venv') {
  const dir = path.resolve(rest[1]);
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pyvenv.cfg'), 'version = 3.12.3\\n');
  // Кладём сам скрипт, а не оболочку: созданному python нужен исполняемый
  // файл, который умеет запуститься без оболочки и без расширения.
  fs.writeFileSync(path.join(dir, 'bin', 'python'), '#!/usr/bin/env node\\n' + process.env.FAKE_SOURCE);
  fs.chmodSync(path.join(dir, 'bin', 'python'), 0o755);
  process.exit(0);
}
if (mode === '-m' && rest[0] === 'pip' && rest[1] === 'check') {
  const lines = process.env.FAKE_PIP_OUT ?? '';
  if (lines) process.stdout.write(lines + '\\n');
  process.exit(Number(process.env.FAKE_PIP_EXIT ?? '0'));
}
process.exit(0);
`;
    await fs.writeFile(script, source, 'utf8');
    // Тот же код без заголовка: `FAKE_SOURCE` пригодится ещё и заглушке внутри.
    process.env.FAKE_SELF_SOURCE = source;
    // `runCommand` запускает ОДИН файл (spawn, а не строка с кавычками): путь
    // с пробелами и `node "скрипт"` он примет за имя программы и даст ENOENT.
    // Поэтому база — исполняемый файл: на Windows — `.cmd`, который зовёт node.
    const exe = process.platform === 'win32' ? path.join(bin, 'python-fake.cmd') : path.join(bin, 'python-fake');
    const launcher =
      process.platform === 'win32'
        ? `@"${process.execPath}" "${script}" %*\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`;
    await fs.writeFile(exe, launcher, { encoding: 'utf8', mode: 0o755 });
    return {
      base: exe,
      // Текст заглушки целиком: createVenv кладёт его в окружение через FAKE_SOURCE.
      source,
      calls: async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean),
    };
  }

  /** Запустить createVenv с заданным ответом заглушки на `pip check`. */
  async function create(
    root: string,
    base: string,
    source: string,
    env: { exit: number; out?: string; preset?: VenvInstallPreset },
  ) {
    process.env.FAKE_LOG = path.join(root, 'calls.log');
    // Скрипт уезжает в окружение целиком: копия должна работать без оболочки.
    process.env.FAKE_SOURCE = source;
    process.env.FAKE_PIP_EXIT = String(env.exit);
    process.env.FAKE_PIP_OUT = env.out ?? '';
    const events: VenvProgressPayload[] = [];
    const result = await createVenv(
      root,
      root,
      { location: 'project', name: '.venv', preset: env.preset ?? 'empty', installRequirements: false, base },
      (event) => events.push(event),
    );
    delete process.env.FAKE_LOG;
    delete process.env.FAKE_SOURCE;
    delete process.env.FAKE_PIP_EXIT;
    delete process.env.FAKE_PIP_OUT;
    return {
      result,
      events,
      calls: async () =>
        (await fs.readFile(path.join(root, 'calls.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean),
    };
  }

  it('после установки пакетов спрашивает pip check и отдаёт конфликты из кода 1', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-venvcheck-'));
    dirs.push(root);
    const { base, source } = await fakePython(root);

    const { result, events, calls } = await create(root, base, source, {
      exit: 1,
      preset: 'pytest',
      out: 'pkg-a 1.0 requires pkg-b<2, but you have pkg-b 2.1 which is incompatible.',
    });

    expect(result.environment.python).toBe(venvPythonPath(path.join(root, '.venv'), process.platform));
    expect(result.conflicts).toEqual(['pkg-a 1.0 requires pkg-b<2, but you have pkg-b 2.1 which is incompatible.']);
    // Код 1 — ответ, а не поломка: окружение создано и возвращено.
    expect(result.installed).toEqual(['pytest', 'pytest-cov']);
    expect((await calls()).join(' | ')).toContain('-m pip check');
    // Строка конфликта доехала до окна прогресса, а не осталась в переменной.
    expect(events.some((event) => event.type === 'output' && event.message.includes('pkg-b 2.1'))).toBe(true);
  });

  it('чистое окружение — без поля conflicts, но с вызовом проверки', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-venvcheck-'));
    dirs.push(root);
    const { base, source } = await fakePython(root);

    const { result, calls } = await create(root, base, source, {
      exit: 0,
      out: 'No broken requirements found.',
      preset: 'pytest',
    });

    // Код 0 — конфликтов нет, но сама проверка была: пустой список без вызова не отличить.
    expect(result.conflicts).toBeUndefined();
    expect((await calls()).join(' | ')).toContain('-m pip check');
  });

  it('отмена во время pip check убивает процесс, а не ждёт его ответа', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-venvcheck-'));
    dirs.push(root);
    const ac = new AbortController();
    const run = runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], root, () => undefined, ac.signal);
    // Отмена закрывает промис сразу, а не через минуту. Отказ помечен как отмена:
    // это ответ на нажатие, а не поломка инструмента.
    ac.abort();
    await expect(run).rejects.toThrow('Отменено');
  });

  it('пустое окружение без пакетов не проверяет: проверять нечего', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-venvcheck-'));
    dirs.push(root);
    const { base, source } = await fakePython(root);

    const { result, calls } = await create(root, base, source, { exit: 1, out: 'не должно попасть' });

    expect(result.installed).toEqual([]);
    expect(result.conflicts).toBeUndefined();
    expect((await calls()).join(' | ')).not.toContain('-m pip check');
  });
});
