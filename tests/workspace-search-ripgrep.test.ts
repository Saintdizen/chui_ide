import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Путь поиска через настоящий ripgrep.
 *
 * `rg` в системе НЕ установлен, поэтому ветвь `searchWithRipgrep` в обычном
 * прогоне не исполняется вовсе: тест подставляет в PATH поддельный `rg`,
 * который печатает заранее собранный `--json`. Так проверяется именно то, чего
 * нет у собственного обхода: пересчёт путей в абсолютные, пересчёт столбца из
 * БАЙТ в символы (кириллица!), привязка контекста и честное `searched` из
 * итоговой записи `summary`.
 *
 * Ничего общего с запуском настоящего ripgrep: форма вывода зафиксирована
 * в tests/ripgrep*.test.ts, здесь важна склейка её с WorkspaceService.
 */

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

/** Временный каталог для проекта и для заглушки. */
async function makeDir(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-rg-')));
  roots.push(dir);
  return dir;
}

/**
 * Кладёт в PATH поддельный `rg`.
 *
 * `--version` отвечает 0 (иначе `hasRipgrep` скажет «нет команды»), остальные
 * вызовы печатают `output` и пишут свои аргументы в файл — по нему видно,
 * что именно мы попросили искать.
 */
async function withRipgrep(output: string): Promise<{ args: () => Promise<string>; restore: () => void }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-rg-stub-'));
  roots.push(dir);
  const argsFile = path.join(dir, 'args.txt');
  // Тело — на Node, а не `sh`: на Windows оболочки нет, заглушка молча не
  // запускалась, и ripgrep считался отсутствующим — весь файл краснел зря.
  const script = [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    `fs.appendFileSync(${JSON.stringify(argsFile)}, process.argv.slice(2).map((a) => a + '\\n').join(''));`,
    "if (process.argv[2] === '--version') process.exit(0);",
    `process.stdout.write(${JSON.stringify(output)});`,
    '',
  ].join('\n');
  // На Windows имя с суффиксом .exe (его находит `spawn`), а `chmod` там не работает:
  // права не нужны, и попытка падала на «нет такого файла».
  const names = process.platform === 'win32' ? ['rg.exe'] : ['rg'];
  await fs.writeFile(path.join(dir, names[0]), script, 'utf8');
  if (process.platform !== 'win32') await fs.chmod(path.join(dir, 'rg'), 0o755);
  const previous = process.env.PATH ?? '';
  process.env.PATH = `${dir}${path.delimiter}${previous}`;
  return {
    args: () => fs.readFile(argsFile, 'utf8').catch(() => ''),
    restore: () => {
      process.env.PATH = previous;
    },
  };
}

/** Запись `--json`. */
function match(file: string, line: number, text: string, start = 0): string {
  return JSON.stringify({
    type: 'match',
    data: { path: { text: file }, lines: { text: `${text}\n` }, line_number: line, submatches: [{ start }] },
  });
}

function contextLine(file: string, line: number, text: string): string {
  return JSON.stringify({
    type: 'context',
    data: { path: { text: file }, lines: { text: `${text}\n` }, line_number: line },
  });
}

function summary(searches: number): string {
  return JSON.stringify({ type: 'summary', data: { stats: { searches } } });
}

function service(): WorkspaceService {
  return new WorkspaceService(
    () => undefined,
    () => undefined,
  );
}

describe('search через ripgrep', () => {
  it('путь из --json становится абсолютным, а порядок — по файлу и строке', async () => {
    const root = await makeDir();
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src/a.ts'), 'x\n');
    // ripgrep отдаёт пути ОТНОСИТЕЛЬНО cwd и в обратном порядке — намеренно.
    const a = path.join(root, 'a.ts');
    const b = path.join(root, 'b.ts');
    // Пути в --json абсолютные (как их печатает ripgrep при cwd=области);
    // порядок намеренно обратный, чтобы сортировка была видна.
    const stub = await withRipgrep(
      [match(b, 1, 'needle'), match(a, 9, 'needle'), match(a, 3, 'needle'), summary(4)].join('\n'),
    );
    try {
      const ws = service();
      await ws.open(root);
      const result = await ws.search({ query: 'needle' });
      expect(result.hits.map((h) => [path.basename(h.path), h.line])).toEqual([
        ['a.ts', 3],
        ['a.ts', 9],
        ['b.ts', 1],
      ]);
      expect(result.scanned).toBe(4);
    } finally {
      stub.restore();
    }
  });

  it('столбец считается в СИМВОЛАХ, а ripgrep даёт байты', async () => {
    const root = await makeDir();
    await fs.writeFile(path.join(root, 'a.ts'), 'кириллица\n');
    // «кириллица» — 9 символов по 2 байта; смещение 18 — конец строки.
    const stub = await withRipgrep([match(path.join(root, 'a.ts'), 1, 'кириллица', 18), summary(1)].join('\n'));
    try {
      const ws = service();
      await ws.open(root);
      const result = await ws.search({ query: 'кириллица' });
      // 18 байт = 9 символов, значит столбец 10 (1-based), а не 19.
      expect(result.hits[0]?.column).toBe(10);
    } finally {
      stub.restore();
    }
  });
});

describe('search через ripgrep: контекст и провод', () => {
  it('контекст до совпадения копится, после — пристраивается к нему', async () => {
    const root = await makeDir();
    await fs.writeFile(path.join(root, 'a.ts'), 'x\n');
    const stub = await withRipgrep(
      [
        contextLine(path.join(root, 'a.ts'), 1, 'выше один'),
        contextLine(path.join(root, 'a.ts'), 2, 'выше два'),
        match(path.join(root, 'a.ts'), 3, 'тут'),
        contextLine(path.join(root, 'a.ts'), 4, 'ниже'),
        summary(1),
      ].join('\n'),
    );
    try {
      const ws = service();
      await ws.open(root);
      const result = await ws.search({ query: 'тут', context: 2 });
      expect(result.hits[0]?.before).toEqual(['выше один', 'выше два']);
      expect(result.hits[0]?.after).toEqual(['ниже']);
    } finally {
      stub.restore();
    }
  });

  it('на проводе: маска, отказ от конфига, точный регистр', async () => {
    const root = await makeDir();
    await fs.writeFile(path.join(root, 'a.ts'), 'x\n');
    const stub = await withRipgrep([match(path.join(root, 'a.ts'), 1, 'q'), summary(1)].join('\n'));
    try {
      const ws = service();
      await ws.open(root);
      await ws.search({ query: 'q', glob: '*.ts', caseSensitive: true, maxResults: 5 });
      const args = await stub.args();
      expect(args).toContain('--no-config');
      expect(args).toContain('--stats');
      // Маска без слэша привязывается к корню — иначе «*.ts на любой глубине».
      expect(args).toContain('/*.ts');
      expect(args).toContain('-s');
    } finally {
      stub.restore();
    }
  });
});

describe('search через ripgrep: отказы', () => {
  it('пустой вывод — «ничего не нашлось», а не повод искать заново', async () => {
    const root = await makeDir();
    await fs.writeFile(path.join(root, 'a.ts'), 'тут есть\n');
    const stub = await withRipgrep('');
    try {
      const ws = service();
      await ws.open(root);
      // На диске запрос есть, но ripgrep «не нашёл»: верим ему, а не диску.
      const result = await ws.search({ query: 'тут' });
      expect(result.hits).toEqual([]);
    } finally {
      stub.restore();
    }
  });

  it('код 1 — «совпадений нет», а не сбой: отката нет, выдача пуста', async () => {
    const root = await makeDir();
    await fs.writeFile(path.join(root, 'a.ts'), 'нужное\n');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-rg-one-'));
    roots.push(dir);
    await fs.writeFile(path.join(dir, 'rg'), '#!/bin/sh\ncase "$1" in --version) exit 0;; esac\nexit 1\n', 'utf8');
    await fs.chmod(path.join(dir, 'rg'), 0o755);
    const previous = process.env.PATH ?? '';
    process.env.PATH = `${dir}${path.delimiter}${previous}`;
    try {
      const ws = service();
      await ws.open(root);
      const result = await ws.search({ query: 'нужное' });
      // В ripgrep 1 — законный «ничего не нашлось». Веры диску это не даёт:
      // обход fs не запускается, иначе мы бы дважды платили за тот же ответ.
      expect(result.hits).toEqual([]);
    } finally {
      process.env.PATH = previous;
    }
  });

  it('код 2 — настоящий сбой ripgrep, и тогда спасает собственный обход', async () => {
    const root = await makeDir();
    await fs.writeFile(path.join(root, 'a.ts'), 'нужное\n');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-rg-bad-'));
    roots.push(dir);
    // --version отвечает 0 (команда «есть»), а поиск падает с кодом 1.
    await fs.writeFile(path.join(dir, 'rg'), '#!/bin/sh\ncase "$1" in --version) exit 0;; esac\nexit 2\n', 'utf8');
    await fs.chmod(path.join(dir, 'rg'), 0o755);
    const previous = process.env.PATH ?? '';
    process.env.PATH = `${dir}${path.delimiter}${previous}`;
    try {
      const ws = service();
      await ws.open(root);
      const result = await ws.search({ query: 'нужное' });
      // Сбой ripgrep не должен превращаться в пустую выдачу: свой обход нашёл.
      expect(result.hits.map((h) => path.basename(h.path))).toEqual(['a.ts']);
    } finally {
      process.env.PATH = previous;
    }
  });
});
