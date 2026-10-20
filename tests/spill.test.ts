import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGED_KIND, createSpillStream, MAX_AGED_FILES, MAX_SPILL_FILES, prune, spillHint, spillName, spillText } from '../src/main/ai/spill';

/**
 * Копия длинного вывода.
 *
 * Обрезка нужна — иначе один `npm install` съедает окно модели. Но обрезка «в
 * никуда» теряет данные: агент видит «вывод обрезан» и не может достать
 * отброшенное, а повторный запуск даёт уже другой вывод. Поэтому проверяем два
 * свойства: отброшенное действительно ложится в файл, и файл не появляется там,
 * где он не нужен (иначе каталог растёт на каждый вызов инструмента).
 */

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chui-spill-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('spillText', () => {
  it('кладёт текст в файл и возвращает путь', () => {
    const dir = tempDir();
    const file = spillText(dir, 'terminal', 'полный вывод');

    expect(file).toBeTruthy();
    expect(fs.readFileSync(file as string, 'utf8')).toBe('полный вывод');
  });

  it('имя файла начинается со времени и содержит инструмент', () => {
    const name = spillName('run_tests', new Date('2026-08-12T17:30:52.637Z'));
    expect(name.startsWith('20260812-173052')).toBe(true);
    expect(name.endsWith('-run_tests.txt')).toBe(true);
  });

  it('причёсывает имя инструмента до безопасного вида', () => {
    // Имя приходит из кода, но путь собирается из него — разделители недопустимы.
    const name = spillName('a b/c');
    expect(name).not.toContain('/');
    expect(name).not.toContain(' ');
  });
});

describe('createSpillStream', () => {
  it('склеивает куски в один файл', () => {
    const dir = tempDir();
    const stream = createSpillStream(dir, 'terminal');
    stream.write('начало ');
    stream.write('середина ');
    stream.write('конец');

    const file = stream.close(true);
    expect(fs.readFileSync(file as string, 'utf8')).toBe('начало середина конец');
  });

  it('короткий вывод не оставляет файла', () => {
    const dir = tempDir();
    const stream = createSpillStream(dir, 'read_file');
    stream.write('немного текста');

    // `keep: false` — вывод и так ушёл модели целиком: копия только мешала бы.
    expect(stream.close(false)).toBeNull();
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
  });

  it('пустой поток не создаёт даже каталога', () => {
    const dir = path.join(tempDir(), 'ai-spill');
    const stream = createSpillStream(dir, 'search');
    expect(stream.close(true)).toBeNull();
    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe('prune', () => {
  it('держит только последние файлы', () => {
    const dir = tempDir();
    for (let index = 0; index < MAX_SPILL_FILES + 5; index += 1) {
      // Имена сортируются как строки, а время в них — в начале.
      fs.writeFileSync(path.join(dir, spillName('terminal', new Date(1_700_000_000_000 + index * 1000))), 'x');
    }

    prune(dir);
    expect(fs.readdirSync(dir)).toHaveLength(MAX_SPILL_FILES);
  });

  it('свёртка не вытесняет хвосты команд', () => {
    const dir = tempDir();
    // Свёртка пишет копию на каждый проход — их много; хвост команды один.
    for (let index = 0; index < MAX_SPILL_FILES + 10; index += 1) {
      fs.writeFileSync(path.join(dir, spillName(AGED_KIND, new Date(1_700_000_000_000 + index * 1000))), 'x');
    }
    const terminal = spillName('terminal', new Date(1_700_000_000_000));
    fs.writeFileSync(path.join(dir, terminal), 'x');

    prune(dir);

    // Хвост команды жив: у свёртки свой потолок.
    expect(fs.existsSync(path.join(dir, terminal))).toBe(true);
    const aged = fs.readdirSync(dir).filter((name) => name.includes(AGED_KIND));
    expect(aged).toHaveLength(MAX_AGED_FILES);
  });
});

describe('spillHint', () => {
  it('говорит модели, чем прочитать файл', () => {
    const hint = spillHint('/tmp/ai-spill/20260812-173052-terminal.txt');
    expect(hint).toContain('read');
    expect(hint).toContain('/tmp/ai-spill/20260812-173052-terminal.txt');
  });
});
