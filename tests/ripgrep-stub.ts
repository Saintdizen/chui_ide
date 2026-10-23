/**
 * Поддельный `rg` для тестов: подкладывает в PATH свою программу, пишет в файл
 * пришедшие аргументы и отдаёт заданный вывод.
 *
 * На Windows без оболочки спавн ищет исполняемый файл только по PATHEXT, поэтому
 * `rg` без расширения и `rg.cmd` для него не существуют (ENOENT). Завести свою
 * `rg.exe` тоже нельзя: начинка не та, что ждёт загрузчик. В таком случае тесты
 * на Windows проверяют только настоящий `rg` из образа, а разбор конкретных
 * аргументов и вывода — на остальных системах, где заглушка работает.
 */
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

export const stubSupported = process.platform !== 'win32';

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
