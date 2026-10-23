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

/**
 * Поддельный `rg`: настоящий исполняемый файл с телом на Node. Не `sh` — на Windows
 * его нет, и тест молча получал `null`: `rg` якобы не установлен, а решения
 * сервиса при таком ответе другие, и проверка ничего не доказывала.
 *
 * На POSIX обычный файл с шебангом запускается только через execvp, а спавн
 * без дисплея идёт в оболочке через PATH — так и происходит в бою. На Windows
 * исполняется `rg.exe`: имя с расширением — единственное, что найдёт `where`.
 */
async function withFakeRg(body: string): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-rg-fail-'));
  roots.push(dir);
  const file = path.join(dir, process.platform === 'win32' ? 'rg.exe' : 'rg');
  await fs.writeFile(file, `#!/usr/bin/env node\n${body}\n`, 'utf8');
  // На Windows права не нужны, а `chmod` там падает: файла `rg` без `.exe` нет.
  if (process.platform !== 'win32') await fs.chmod(file, 0o755);
  const previous = process.env.PATH ?? '';
  process.env.PATH = `${dir}${path.delimiter}${previous}`;
  // Возврат PATH — через afterEach неудобно: сохраняем в замыкании хука.
  afterEach(() => {
    process.env.PATH = previous;
  });
}

/**
 * Тело поддельного `rg`: проверка `--version` и действие `body`. Без `sh`: тело
 * пишется на Node, как и сам файл.
 */
function script(body: string): string {
  return `if (process.argv[2] === '--version') process.exit(0);\n${body}`;
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
    await withFakeRg(script(`process.stderr.write('битый шаблон\\n');\nprocess.exit(2);`));
    await expect(runRipgrep(['--json', '-e', 'x', '.'], os.tmpdir())).rejects.toThrow(
      'rg завершился с кодом 2: битый шаблон',
    );
  });

  it('совпадений нет (код 1) — это результат, а не отказ', async () => {
    await withFakeRg(script(`process.stdout.write('итог\\n');\nprocess.exit(1);`));
    expect(await runRipgrep(['--json', '-e', 'x', '.'], os.tmpdir())).toBe('итог\n');
  });

  it('прерванный поиск убивает процесс', async () => {
    // Скрипт живёт, пока его не убьют: проверяем, что сигнал доходит.
    const marker = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-rg-kill-'));
    roots.push(marker);
    const died = path.join(marker, 'died.txt');
    // Сам сигнал на Windows не ловится: там процесс просто завершается убийством._
    const diedLiteral = JSON.stringify(died);
    await withFakeRg(
      script(
        `process.on('SIGTERM', () => { require('node:fs').writeFileSync(${diedLiteral}, 'да'); process.exit(143); });\nsetTimeout(() => {}, 5000);`,
      ),
    );

    const controller = new AbortController();
    const pending = runRipgrep(['--json', '-e', 'x', '.'], os.tmpdir(), controller.signal);
    setTimeout(() => controller.abort(), 150);
    await expect(pending).rejects.toThrow('rg завершился с кодом 143: ');
    // Обработчик TERM сработал — процесс был именно убит, а не истёк сам.
    await expect(fs.readFile(died, 'utf8')).resolves.toContain('да');
  });
});
