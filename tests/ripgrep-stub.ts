/**
 * Поддельный `rg` для тестов: подкладывает в PATH свою программу, пишет в файл
 * пришедшие аргументы и отдаёт заданный вывод.
 *
 * На Windows спавн ищет исполняемый файл по PATHEXT, поэтому имя без расширения
 * он находит только как `rg.cmd` — а его запускает через cmd.exe. Вместо отказа
 * от заглушки пишем ещё и `.cmd`-обёртку, зовущую node с тем же телом: PATH и
 * разбор аргументов тогда проверяются на всех системах, а не на двух из трёх.
 * Настоящий `rg` из образа эти тесты тоже видят — если стоит `rg.cmd` в пути
 * раньше настоящего, заглушка побеждает, и это ожидаемо.
 */
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

/** Заглушка работает везде: на Windows её представляет `rg.cmd`. */
export const stubSupported = true;

export interface RipgrepStub {
  /** Аргументы последнего запуска, по одному в строке. */
  args(): Promise<string>;
  restore(): void;
}

export async function withRipgrep(output: string, name = 'rg'): Promise<RipgrepStub> {
  const dir = await mkdtemp(join(tmpdir(), 'chui-rg-stub-'));
  const argsFile = join(dir, 'args.txt');
  const body = [
    "const fs = require('node:fs');",
    `fs.appendFileSync(${JSON.stringify(argsFile)}, process.argv.slice(2).map((a) => a + '\\n').join(''));`,
    "if (process.argv[2] === '--version') process.exit(0);",
    `process.stdout.write(${JSON.stringify(output)});`,
    '',
  ].join('\n');
  const file = join(dir, name);
  await writeFile(file, `#!/usr/bin/env node\n${body}\n`, 'utf8');
  await chmod(file, 0o755);
  // Windows не запускает файл без расширения: спавн ищет `rg` по PATHEXT и
  // находит только `rg.cmd`, запуская его через cmd.exe.
  const cmd = join(dir, `${name}.cmd`);
  await writeFile(cmd, `@echo off\r\n"${process.execPath}" "${file}" %*\r\n`, 'utf8');
  const previous = process.env.PATH ?? '';
  process.env.PATH = `${dir}${delimiter}${previous}`;
  return {
    args: () => readFile(argsFile, 'utf8').catch(() => ''),
    restore: () => {
      process.env.PATH = previous;
      void rm(dir, { recursive: true, force: true });
    },
  };
}
