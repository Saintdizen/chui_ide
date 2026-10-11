import { describe, expect, it } from 'vitest';
import { DEFAULT_SNIPPETS, normalizeSnippets, snippetsForLanguage } from '../src/shared/snippets';

describe('normalizeSnippets', () => {
  it('оставляет пригодные записи и переносит описание', () => {
    const result = normalizeSnippets([{ prefix: 'fn', body: 'function ${1}(){}', description: 'функция' }]);

    expect(result).toEqual([{ prefix: 'fn', body: 'function ${1}(){}', description: 'функция' }]);
  });

  it('языки приводит к списку без повторов, пустой список опускает', () => {
    const result = normalizeSnippets([{ prefix: 'x', body: 'y', languages: ['python', 'python', 'js', ' '] }]);

    expect(result[0]!.languages).toEqual(['python', 'js']);
    expect(normalizeSnippets([{ prefix: 'x', body: 'y', languages: [] }])[0]!.languages).toBeUndefined();
  });

  it('мусор и записи без триггера или тела отбрасывает', () => {
    const result = normalizeSnippets([
      null,
      42,
      'строка',
      { prefix: '', body: 'y' },
      { prefix: 'x', body: '   ' },
      { prefix: 'с пробелом', body: 'y' },
      { prefix: 'ok', body: 'y' },
    ]);

    expect(result).toEqual([{ prefix: 'ok', body: 'y' }]);
  });

  it('не-массив даёт пустой список', () => {
    expect(normalizeSnippets(undefined)).toEqual([]);
    expect(normalizeSnippets({ prefix: 'x' })).toEqual([]);
  });

  it('повторы по триггеру и языкам убирает, оставляя первый', () => {
    const result = normalizeSnippets([
      { prefix: 'x', body: 'первый' },
      { prefix: 'x', body: 'второй' },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]!.body).toBe('первый');
  });

  it('обрезает слишком длинное тело, а не падает', () => {
    const result = normalizeSnippets([{ prefix: 'long', body: 'a'.repeat(5000) }]);

    expect(result[0]!.body.length).toBe(2000);
  });
});

describe('snippetsForLanguage', () => {
  it('сниппет без языков применим везде', () => {
    const snippets = normalizeSnippets([{ prefix: 'any', body: 'x' }]);

    expect(snippetsForLanguage(snippets, 'python')).toHaveLength(1);
    expect(snippetsForLanguage(snippets, 'rust')).toHaveLength(1);
  });

  it('с ограничением языков — только на своём', () => {
    const snippets = normalizeSnippets([{ prefix: 'py', body: 'x', languages: ['python'] }]);

    expect(snippetsForLanguage(snippets, 'python')).toHaveLength(1);
    expect(snippetsForLanguage(snippets, 'typescript')).toHaveLength(0);
  });
});

describe('DEFAULT_SNIPPETS', () => {
  it('набор проходит собственную проверку без потерь', () => {
    // Набор по умолчанию — тоже данные: он должен переживать normalizeSnippets целиком.
    expect(normalizeSnippets(DEFAULT_SNIPPETS)).toHaveLength(DEFAULT_SNIPPETS.length);
  });

  it('у каждого сниппета есть триггер, тело и описание', () => {
    for (const snippet of DEFAULT_SNIPPETS) {
      expect(snippet.prefix.length).toBeGreaterThan(0);
      expect(snippet.body.length).toBeGreaterThan(0);
      expect(snippet.description).toBeTruthy();
    }
  });
});
