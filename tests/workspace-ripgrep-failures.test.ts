import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runRipgrep } from '../src/main/workspace/workspace';

/**
 * Что делает поиск, когда `rg` недоступен: упал, завис, его прервали.
 *
 * Дорога ошибки тут одна: молчание. Если сбой `rg` превратится в «ничего не
 * найдено», человек получит уверенный пустой ответ там, где на самом деле
 * поиск не состоялся. Поэтому проверяем не текст, а решения: `null` —
 * команды нет (жить можно, есть свой обход), отказ — сбой поиска.
 */

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

/** Поддельный `rg` с готовым телом скрипта. */
async function withFakeRg(body: string): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-rg-fail-'));
  roots.push(dir);
  await fs.writeFile(path.join(dir, 'rg'), `#!/bin/sh\n${body}\n`, 'utf8');
  await fs.chmod(path.join(dir, 'rg'), 0o755);
  const previous = process.env.PATH ?? '';
  process.env.PATH = `${dir}${path.delimiter}${previous}`;
  // Возврат PATH — через afterEach неудобно: сохраняем в замыкании хука.
  afterEach(() => {
    process.env.PATH = previous;
  });
}

describe('сбои rg', () => {
  it('нет команды — null, а не ошибка и не пустой результат', async () => {
    // PATH без rg: только пустой каталог, чтобы ничего не нашлось случайно.
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-empty-'));
    roots.push(empty);
    const previous = process.env.PATH;
    process.env.PATH = empty;
    try {
      expect(await runRipgrep(['--version'], os.tmpdir())).toBeNull();
    } finally {
      process.env.PATH = previous;
    }
  });

  it('сбой поиска (код 2) — отказ с причиной из stderr', async () => {
    await withFakeRg('case "$1" in --version) exit 0 ;; esac\necho "битый шаблон" >&2\nexit 2');
    await expect(runRipgrep(['--json', '-e', 'x', '.'], os.tmpdir())).rejects.toThrow(
      'rg завершился с кодом 2: битый шаблон',
    );
  });

  it('совпадений нет (код 1) — это результат, а не отказ', async () => {
    await withFakeRg('case "$1" in --version) exit 0 ;; esac\necho "итог"\nexit 1');
    expect(await runRipgrep(['--json', '-e', 'x', '.'], os.tmpdir())).toBe('итог\n');
  });

  it('прерванный поиск убивает процесс', async () => {
    // Скрипт живёт, пока его не убьют: проверяем, что сигнал доходит.
    const marker = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-rg-kill-'));
    roots.push(marker);
    const died = path.join(marker, 'died.txt');
    await withFakeRg(`case "$1" in --version) exit 0 ;; esac\ntrap 'echo да > "${died}"; exit 143' TERM\nsleep 5\n`);

    const controller = new AbortController();
    const pending = runRipgrep(['--json', '-e', 'x', '.'], os.tmpdir(), controller.signal);
    setTimeout(() => controller.abort(), 150);
    await expect(pending).rejects.toThrow('rg завершился с кодом 143: ');
    // Обработчик TERM сработал — процесс был именно убит, а не истёк сам.
    await expect(fs.readFile(died, 'utf8')).resolves.toContain('да');
  });
});
