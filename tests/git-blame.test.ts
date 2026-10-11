import { describe, expect, it } from 'vitest';
import { formatBlame, parseBlamePorcelain } from '../src/shared/git-blame';

/**
 * Разбор `git blame --line-porcelain` и отчёт по нему. Правило, а не запуск:
 * формата ответа хватает, чтобы проверить и разбор, и группировку без git.
 */

// Реальный вывод: два коммита, разные авторы; строки 1 и 3 — из первого,
// 2 и 4 — из второго (`previous` и `boundary` намеренно присутствуют).
const PORCELAIN = [
  'd44a36e71d054668928cfca8d61be21490777c88 1 1 1',
  'author Alice',
  'author-mail <a@b.c>',
  'author-time 1700000000',
  'author-tz +0300',
  'summary initial',
  'boundary',
  'filename f.txt',
  '\tone',
  'dfa5de488194232bacc3f69cf674722888c3d09a 2 2 1',
  'author Bob',
  'author-mail <b@c.d>',
  'author-time 1700086400',
  'summary edit line 2',
  'previous d44a36e71d054668928cfca8d61be21490777c88 f.txt',
  'filename f.txt',
  '\tCHANGED',
  'd44a36e71d054668928cfca8d61be21490777c88 3 3 1',
  'author Alice',
  'author-mail <a@b.c>',
  'author-time 1700000000',
  'author-tz +0300',
  'summary initial',
  'boundary',
  'filename f.txt',
  '\tthree',
].join('\n');

describe('parseBlamePorcelain', () => {
  it('читает строки, авторов, даты и сообщения', () => {
    const lines = parseBlamePorcelain(PORCELAIN);

    expect(lines).toHaveLength(3);
    expect(lines[0]).toEqual({
      line: 1,
      hash: 'd44a36e',
      author: 'Alice',
      date: '2023-11-14',
      summary: 'initial',
      text: 'one',
    });
    expect(lines[1]!.hash).toBe('dfa5de4');
    expect(lines[1]!.author).toBe('Bob');
    expect(lines[1]!.text).toBe('CHANGED');
  });

  it('хеш показывается коротким', () => {
    expect(parseBlamePorcelain(PORCELAIN)[0]!.hash).toHaveLength(7);
  });

  it('пустой вывод — пустой список', () => {
    expect(parseBlamePorcelain('')).toEqual([]);
  });

  it('битый блок без автора пропускается, а не даёт «неизвестно»', () => {
    const broken = ['abc123 1 1 1', 'summary x', '\ttext'].join('\n');
    expect(parseBlamePorcelain(broken)).toEqual([]);
  });

  it('строки с CRLF разбираются так же, как с LF', () => {
    // Так выглядит вывод git на Windows: возврат каретки не должен ломать ни
    // заголовок блока, ни текст строки.
    const crlf = PORCELAIN.replace(/\n/g, '\r\n');

    const lines = parseBlamePorcelain(crlf);

    expect(lines).toHaveLength(3);
    expect(lines[0]!.text).toBe('one');
    expect(lines[1]!.text).toBe('CHANGED');
  });
});

describe('formatBlame', () => {
  it('сливает подряд идущие строки одного коммита в один блок', () => {
    const lines = [
      { line: 1, hash: 'aaaaaaa', author: 'A', date: '2026-01-01', summary: 'first', text: 'one' },
      { line: 2, hash: 'aaaaaaa', author: 'A', date: '2026-01-01', summary: 'first', text: 'two' },
      { line: 3, hash: 'bbbbbbb', author: 'B', date: '2026-01-02', summary: 'second', text: 'three' },
    ];
    const report = formatBlame('f.txt', lines);

    expect(report.summary).toBe('f.txt: строк 3, авторов 2');
    expect(report.detail.split('\n')).toEqual([
      'aaaaaaa A 2026-01-01 — first',
      '  1: one',
      '  2: two',
      'bbbbbbb B 2026-01-02 — second',
      '  3: three',
    ]);
  });

  it('без сообщения коммита подставляет явную пометку', () => {
    const report = formatBlame('f.txt', [
      { line: 1, hash: 'aaaaaaa', author: 'A', date: '2026-01-01', summary: '', text: 'x' },
    ]);
    expect(report.detail).toContain('(без сообщения)');
  });

  it('пустой blame говорит об этом словами', () => {
    const report = formatBlame('f.txt', []);
    expect(report.summary).toContain('blame пуст');
  });

  it('длинный список ограничен, но число строк названо', () => {
    const lines = Array.from({ length: 205 }, (_value, index) => ({
      line: index + 1,
      hash: `h${index}`,
      author: 'A',
      date: '2026-01-01',
      summary: 's',
      text: 't',
    }));
    const report = formatBlame('f.txt', lines);
    expect(report.summary).toContain('строк 205');
    expect(report.detail).toContain('… ещё строк: 5');
  });
});
