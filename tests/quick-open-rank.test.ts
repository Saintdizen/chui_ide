import { describe, expect, it } from 'vitest';
import { rankFiles } from '../src/renderer/core/quick-open-rank';

const FILES = [
  'README.md',
  'package.json',
  'src/queue.js',
  'src/app.js',
  'src/renderer/ui/chat-text.ts',
  'src/renderer/ui/chat.ts',
  'scripts/dev.mjs',
  'docs/roadmap.md',
];

describe('rankFiles', () => {
  it('пустой запрос — начало списка', () => {
    expect(rankFiles(FILES, '')).toEqual(FILES.slice(0, 50));
  });

  it('пустой запрос уважает limit', () => {
    expect(rankFiles(FILES, '', 3)).toHaveLength(3);
  });

  it('подстрока в имени файла находит файл', () => {
    expect(rankFiles(FILES, 'queue')).toContain('src/queue.js');
  });

  it('совпадение в имени ценится выше, чем в пути', () => {
    // «chat» есть и в имени файла (chat.ts), и в пути (chat-text.ts) — оба подходят.
    const result = rankFiles(FILES, 'chat');
    expect(result).toContain('src/renderer/ui/chat.ts');
    expect(result).toContain('src/renderer/ui/chat-text.ts');
  });

  it('подпоследовательность: «qjs» находит queue.js', () => {
    expect(rankFiles(FILES, 'qjs')).toContain('src/queue.js');
  });

  it('нет совпадений — пустой список', () => {
    expect(rankFiles(FILES, 'zzzzz')).toEqual([]);
  });

  it('регистр не важен', () => {
    expect(rankFiles(FILES, 'README')).toContain('README.md');
  });

  it('совпадение в начале имени выше, чем в середине пути', () => {
    const files = ['a/xyz/depth.ts', 'xyz.ts', 'nested/doc/xyz.md'];
    // «xyz.ts» начинается с запроса — должен быть первым.
    expect(rankFiles(files, 'xyz.ts')[0]).toBe('xyz.ts');
  });

  it('сортировка стабильна при равном счёте', () => {
    const files = ['b/app.ts', 'a/app.ts'];
    const result = rankFiles(files, 'app');
    expect(result).toEqual(['a/app.ts', 'b/app.ts']);
  });

  it('пробелы в запросе игнорируются по краям', () => {
    expect(rankFiles(FILES, '  queue  ')).toContain('src/queue.js');
  });
});
