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

  describe('недавние (MRU)', () => {
    it('пустой запрос идёт по истории, а не по алфавиту', () => {
      const recent = ['src/renderer/ui/chat.ts', 'docs/roadmap.md'];
      expect(rankFiles(FILES, '', 50, recent).slice(0, 2)).toEqual(recent);
    });

    it('после недавних — остальное без повторов', () => {
      const result = rankFiles(FILES, '', 50, ['src/app.js']);
      expect(result[0]).toBe('src/app.js');
      // Каждый путь ровно один раз: история не дублирует список.
      expect(new Set(result).size).toBe(result.length);
      expect(result).toHaveLength(FILES.length);
    });

    it('чужие для проекта пути из общей истории отбрасываются', () => {
      // История общая на все проекты: открытый когда-то другой проект палитре не нужен.
      const result = rankFiles(FILES, '', 3, ['/other/project/file.ts', 'README.md']);
      expect(result).toEqual(['README.md', 'package.json', 'src/queue.js']);
    });

    it('недавние уважают limit на пустом запросе', () => {
      expect(rankFiles(FILES, '', 2, ['docs/roadmap.md', 'README.md'])).toEqual(['docs/roadmap.md', 'README.md']);
    });

    it('с запросом недавнее даёт надбавку, а совпадение в имени её перебивает', () => {
      // «app.ts» и «append.ts» начинаются с запроса одинаково — тогда решает история.
      expect(rankFiles(['app.ts', 'append.ts'], 'app', 50, ['append.ts'])[0]).toBe('append.ts');
      // Совпадение в пути подряд выше, чем буквы по порядку в имени.
      expect(rankFiles(['src/config.ts', 'cfg.ts'], 'cfg', 50)[0]).toBe('cfg.ts');
      // При равном совпадении недавний из них — первый.
      expect(rankFiles(['cfg.ts', 'app/cfg.ts'], 'cfg', 50, ['app/cfg.ts'])[0]).toBe('app/cfg.ts');
    });
  });
});
