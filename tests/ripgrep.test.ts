import { describe, expect, it } from 'vitest';
import { parseRipgrepJson, ripgrepArgs } from '../src/shared/ripgrep';

/** Запись `--json`, как её печатает ripgrep: одной строкой на событие. */
const jsonLine = (record: unknown): string => `${JSON.stringify(record)}\n`;

const match = (path: string, line: number, text: string, start = 0): string =>
  jsonLine({
    type: 'match',
    data: {
      path: { text: path },
      lines: { text: `${text}\n` },
      line_number: line,
      submatches: [{ match: { text: text.trim() }, start, end: start + text.trim().length }],
    },
  });

const context = (path: string, line: number, text: string): string =>
  jsonLine({ type: 'context', data: { path: { text: path }, lines: { text: `${text}\n` }, line_number: line } });

describe('ripgrepArgs', () => {
  const base = { query: 'needle' };

  it('просит машинный вывод и не читает чужой конфиг', () => {
    const args = ripgrepArgs(base, [], 200, 0);
    // --no-config обязателен: иначе поведение поиска зависело бы от машины.
    expect(args).toContain('--json');
    expect(args).toContain('--no-config');
  });

  it('обычная строка ищется буквально, регулярка — как регулярка', () => {
    expect(ripgrepArgs(base, [], 200, 0)).toContain('-F');
    expect(ripgrepArgs({ ...base, isRegex: true }, [], 200, 0)).not.toContain('-F');
  });

  it('регистр задаётся явно: smart-case ripgrep нам не подходит', () => {
    expect(ripgrepArgs(base, [], 200, 0)).toContain('-i');
    expect(ripgrepArgs({ ...base, caseSensitive: true }, [], 200, 0)).toContain('-s');
    expect(ripgrepArgs({ ...base, caseSensitive: true }, [], 200, 0)).not.toContain('-i');
  });

  it('служебные каталоги исключаются — как в собственном обходе', () => {
    const args = ripgrepArgs(base, ['node_modules', '.git'], 200, 0);
    expect(args).toContain('!node_modules');
    expect(args).toContain('!.git');
  });

  it('контекст задаётся с обеих сторон, а без него флагов нет', () => {
    expect(ripgrepArgs(base, [], 200, 3)).toEqual(expect.arrayContaining(['-A', '3', '-B', '3']));
    expect(ripgrepArgs(base, [], 200, 0)).not.toContain('-A');
  });

  it('запрос отделён от путей: строка с дефиса не станет флагом', () => {
    const args = ripgrepArgs({ query: '--help' }, [], 200, 0);
    expect(args[args.length - 2]).toBe('--');
    expect(args[args.length - 1]).toBe('.');
  });

  it('область поиска попадает последним аргументом', () => {
    expect(ripgrepArgs({ ...base, path: 'src' }, [], 200, 0).at(-1)).toBe('src');
  });

  it('маска без слэша привязывается к области — как в собственном обходе', () => {
    // У ripgrep `*.py` ловит файлы на любой глубине, а у нас — прямо в области поиска.
    // Ведущий слэш возвращает маске тот же смысл, что и у собственного обхода.
    const args = ripgrepArgs({ ...base, glob: '*.py' }, [], 200, 0);
    expect(args).toContain('/*.py');
    expect(args).not.toContain('*.py');
  });

  it('маска со слэшем не трогается: она и так привязана к корню', () => {
    expect(ripgrepArgs({ ...base, glob: 'src/*.py' }, [], 200, 0)).toContain('src/*.py');
  });
});

describe('parseRipgrepJson', () => {
  it('совпадение даёт путь, строку, столбец и текст', () => {
    const output = match('/p/src/a.ts', 3, 'const needle = 1;', 6);
    const result = parseRipgrepJson(output, { query: 'needle' }, 200);
    expect(result.hits).toEqual([{ path: '/p/src/a.ts', line: 3, column: 7, text: 'const needle = 1;' }]);
  });

  it('столбец считается в символах, хотя ripgrep даёт байты', () => {
    // «при» — 6 байт UTF-8 и 3 символа: без пересчёта столбец уехал бы вправо.
    const output = match('/p/a.py', 1, 'код needle', 7);
    const result = parseRipgrepJson(output, { query: 'needle' }, 200);
    // Кириллица — по 2 байта на символ: смещение в байтах (7) больше столбца (5).
    expect(result.hits[0]!.column).toBe(5);
  });

  it('соседние строки привязываются как before и after', () => {
    const output =
      context('/p/a.ts', 1, 'до') + match('/p/a.ts', 2, 'вот needle тут', 4) + context('/p/a.ts', 3, 'после');
    const result = parseRipgrepJson(output, { query: 'needle', context: 1 }, 200);
    expect(result.hits[0]!.before).toEqual(['до']);
    expect(result.hits[0]!.after).toEqual(['после']);
  });

  it('без контекста соседние строки не прикладываются', () => {
    const output = context('/p/a.ts', 1, 'до') + match('/p/a.ts', 2, 'needle', 0);
    const result = parseRipgrepJson(output, { query: 'needle' }, 200);
    expect(result.hits[0]!.before).toBeUndefined();
    expect(result.hits[0]!.after).toBeUndefined();
  });

  it('в режиме «только имена» от файла остаётся одно совпадение', () => {
    const output = match('/p/a.ts', 1, 'needle') + match('/p/a.ts', 5, 'needle');
    const result = parseRipgrepJson(output, { query: 'needle', filesOnly: true }, 200);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.line).toBe(1);
  });

  it('предел совпадений помечает вывод усечённым', () => {
    const output = match('/p/a.ts', 1, 'needle') + match('/p/a.ts', 2, 'needle');
    const result = parseRipgrepJson(output, { query: 'needle' }, 1);
    expect(result.hits).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it('строки сортируются по файлу и номеру строки', () => {
    const output = match('/p/b.ts', 9, 'needle') + match('/p/a.ts', 7, 'needle');
    const result = parseRipgrepJson(output, { query: 'needle' }, 200);
    expect(result.hits.map((hit) => hit.path)).toEqual(['/p/a.ts', '/p/b.ts']);
  });

  it('битые строки и чужие записи не ломают разбор', () => {
    const output =
      'не json\n' +
      jsonLine({ type: 'begin', data: { path: { text: '/p/a.ts' } } }) +
      jsonLine({ type: 'end', data: { path: { text: '/p/a.ts' }, stats: {} } }) +
      match('/p/a.ts', 2, 'needle');
    const result = parseRipgrepJson(output, { query: 'needle' }, 200);
    expect(result.hits).toHaveLength(1);
  });

  it('пустой вывод — пустой результат', () => {
    expect(parseRipgrepJson('', { query: 'needle' }, 200)).toEqual({ hits: [], truncated: false, scanned: 0 });
  });

  it('длинная строка обрезается тем же потолком, что и в своём обходе', () => {
    const output = match('/p/a.ts', 1, 'x'.repeat(1000), 0);
    const result = parseRipgrepJson(output, { query: 'x' }, 200);
    expect(result.hits[0]!.text.length).toBe(400);
  });
});
