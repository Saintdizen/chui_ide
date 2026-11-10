import { describe, expect, it } from 'vitest';
import {
  completeTerminal,
  dirToRead,
  splitTail,
  type CompletionContext,
} from '../src/renderer/terminal/core/command-completion';

/**
 * Tab в терминале. Не автодополнение «всё как в bash» — только три вещи,
 * которые человек пишет руками: команда, флаг, путь.
 */

const ctx = (over: Partial<CompletionContext> = {}): CompletionContext => ({
  commands: ['git', 'grep', 'gcc', 'ls'],
  history: ['git commit --amend', 'git log --oneline'],
  listDir: (path) => (path === '/p' ? ['src', 'README.md', 'readme.txt'] : null),
  cwd: '/p',
  ...over,
});

describe('splitTail', () => {
  it('делит строку на голову и хвост', () => {
    expect(splitTail('git sta')).toEqual({ head: 'git ', tail: 'sta' });
  });

  it('кавычка остаётся в голове', () => {
    // Пробел внутри кавычек — часть слова: хвост это `fi`, а `cat "my ` уже набрано.
    expect(splitTail('cat "my fi')).toEqual({ head: 'cat "my ', tail: 'fi' });
    // Голова не теряет кавычку — иначе подстановка приклеила бы текст вне строки.
    expect(splitTail('cat "my fi').head).toContain('"');
  });
});

describe('completeTerminal', () => {
  it('одно совпадение команды дописывается с пробелом', () => {
    const result = completeTerminal('gre', ctx({ commands: ['git', 'grep'] }));
    expect(result).toMatchObject({ value: 'grep ', single: true });
  });

  it('несколько — дописывается общее начало', () => {
    const result = completeTerminal('g', ctx());
    expect(result?.single).toBe(false);
    expect(result?.value).toBe('g');
    expect(result?.options).toEqual(['gcc', 'git', 'grep']);
  });

  it('совпадений нет — не мешаем', () => {
    expect(completeTerminal('zzz', ctx())).toBeNull();
  });

  it('флаги берутся из истории', () => {
    const result = completeTerminal('git log --o', ctx());
    expect(result?.value).toBe('git log --oneline ');
  });

  it('путь дополняется по каталогу', () => {
    const result = completeTerminal('cat REA', ctx());
    expect(result?.value).toBe('cat README.md ');
  });

  it('каталог в подсказке с косой чертой', () => {
    const result = completeTerminal('cd sr', ctx());
    expect(result?.options).toContain('src');
  });
});

describe('dirToRead', () => {
  it('относительный путь от текущего каталога', () => {
    expect(dirToRead('sr', '/p')).toBe('/p');
    expect(dirToRead('sub/x', '/p')).toBe('/p/sub');
  });

  it('абсолютный — как есть', () => {
    expect(dirToRead('/etc/pa', '/p')).toBe('/etc');
  });
});
