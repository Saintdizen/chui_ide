import { describe, expect, it } from 'vitest';
import { formatEngine, formatToolNames, nodeFormatOrder, nodeFormatPackage } from '../src/shared/format';

describe('formatEngine', () => {
  it('Python — отдельный движок: инструменты живут в интерпретаторе, а не в node_modules', () => {
    expect(formatEngine('python')).toBe('python');
  });

  it('JS/TS и соседние языки — движок Node-проекта', () => {
    for (const language of ['typescript', 'javascript', 'json', 'html', 'css', 'scss', 'less', 'markdown', 'yaml']) {
      expect(formatEngine(language)).toBe('node');
    }
  });

  it('остальные языки не форматируем: инструмента для них нет', () => {
    for (const language of ['rust', 'go', 'shell', 'sql', 'ini', 'plaintext']) {
      expect(formatEngine(language)).toBeNull();
    }
  });
});

describe('formatToolNames', () => {
  it('подсказка «нечем форматировать» называет инструменты своего движка', () => {
    expect(formatToolNames('python')).toEqual(['ruff', 'black']);
    expect(formatToolNames('node')).toEqual(['prettier', 'biome']);
  });
});

describe('nodeFormatPackage', () => {
  it('biome лежит в scoped-пакете, prettier — в собственном', () => {
    expect(nodeFormatPackage('prettier')).toBe('prettier');
    expect(nodeFormatPackage('biome')).toBe('@biomejs/biome');
  });
});

describe('nodeFormatOrder', () => {
  it('никто не объявлен — обычный порядок: prettier, затем biome', () => {
    expect(nodeFormatOrder([])).toEqual(['prettier', 'biome']);
  });

  it('объявленный инструмент идёт первым: проект уже выбрал, чем форматируется', () => {
    expect(nodeFormatOrder(['@biomejs/biome'])).toEqual(['biome', 'prettier']);
    expect(nodeFormatOrder(['prettier'])).toEqual(['prettier', 'biome']);
  });

  it('оба объявлены — порядок обычный', () => {
    expect(nodeFormatOrder(['prettier', '@biomejs/biome'])).toEqual(['prettier', 'biome']);
    expect(nodeFormatOrder(['@biomejs/biome', 'prettier'])).toEqual(['prettier', 'biome']);
  });

  it('чужие зависимости на порядок не влияют', () => {
    expect(nodeFormatOrder(['zod', 'vitest', '@types/node', 'react'])).toEqual(['prettier', 'biome']);
  });
});
