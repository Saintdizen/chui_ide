import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NESTING_RULES,
  effectiveNestingRules,
  nestEntries,
  parseNestingRules,
} from '../src/renderer/core/file-nesting';

/**
 * Свёртывание связанных файлов под родителя. Правило срабатывает на общий корень
 * имени: `Button.tsx` собирает `Button.module.css` и `Button.test.tsx`.
 */
describe('nestEntries', () => {
  it('спутники уходят под родителя по общему корню', () => {
    const names = ['Button.tsx', 'Button.module.css', 'Button.test.tsx', 'Other.tsx'];
    const nest = nestEntries(names, DEFAULT_NESTING_RULES);
    expect(nest.children.get('Button.tsx')).toEqual(['Button.module.css', 'Button.test.tsx']);
    expect(nest.hidden.has('Button.module.css')).toBe(true);
    expect(nest.hidden.has('Button.test.tsx')).toBe(true);
    expect(nest.hidden.has('Other.tsx')).toBe(false);
  });

  it('чужие корни не собираются вместе', () => {
    const names = ['Button.tsx', 'Input.module.css'];
    expect(nestEntries(names, DEFAULT_NESTING_RULES).children.size).toBe(0);
  });

  it('спутники идут в порядке строк дерева, а не правил', () => {
    const names = ['Button.test.tsx', 'Button.tsx', 'Button.module.css'];
    expect(nestEntries(names, DEFAULT_NESTING_RULES).children.get('Button.tsx')).toEqual([
      'Button.test.tsx',
      'Button.module.css',
    ]);
  });

  it('без родителя спутник остаётся обычной строкой', () => {
    const names = ['Orphan.module.css'];
    const nest = nestEntries(names, DEFAULT_NESTING_RULES);
    expect(nest.hidden.has('Orphan.module.css')).toBe(false);
    expect(nest.children.size).toBe(0);
  });

  it('спутник не становится родителем для другого', () => {
    const names = ['Button.ts', 'Button.d.ts', 'Button.d.map'];
    const nest = nestEntries(names, DEFAULT_NESTING_RULES);
    // Button.d.ts уходит под Button.ts и сам уже ничего не собирает.
    expect(nest.children.get('Button.ts')).toEqual(['Button.d.ts']);
    expect(nest.children.has('Button.d.ts')).toBe(false);
  });

  it('python: тест уходит под модуль', () => {
    const names = ['models.py', 'test_models.py'];
    expect(nestEntries(names, DEFAULT_NESTING_RULES).children.get('models.py')).toEqual(['test_models.py']);
  });

  it('точное правило без звёздочки сверяет имя целиком', () => {
    const names = ['index.ts', 'index.ts.map'];
    const rules = [{ parent: 'index.ts', child: 'index.ts.map' }];
    expect(nestEntries(names, rules).hidden.has('index.ts.map')).toBe(true);
  });
});

describe('parseNestingRules', () => {
  it('разбирает строку с несколькими спутниками', () => {
    expect(parseNestingRules(['*.tsx: *.test.tsx, *.module.css'])).toEqual([
      { parent: '*.tsx', child: '*.test.tsx' },
      { parent: '*.tsx', child: '*.module.css' },
    ]);
  });

  it('строки без двоеточия пропускаются', () => {
    expect(parseNestingRules(['мусор', '*.ts: *.test.ts'])).toEqual([{ parent: '*.ts', child: '*.test.ts' }]);
  });

  it('пустой список — пусто', () => {
    expect(parseNestingRules([])).toEqual([]);
  });
});

describe('effectiveNestingRules', () => {
  it('свои правила заменяют умолчания', () => {
    expect(effectiveNestingRules(['*.md: *.ru.md'])).toEqual([{ parent: '*.md', child: '*.ru.md' }]);
  });

  it('без своих правил берутся умолчания', () => {
    expect(effectiveNestingRules([])).toBe(DEFAULT_NESTING_RULES);
    expect(effectiveNestingRules(['мусор'])).toBe(DEFAULT_NESTING_RULES);
  });
});
