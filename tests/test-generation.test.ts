import { describe, expect, it } from 'vitest';
import {
  buildTestPrompt,
  cleanTestCode,
  isEmptyTest,
  suggestTestPath,
  truncateTestCode,
} from '../src/shared/test-generation';

describe('buildTestPrompt', () => {
  it('кладёт язык, пути и код в ограждение', () => {
    const prompt = buildTestPrompt({
      language: 'typescript',
      relativePath: 'src/sum.ts',
      testPath: 'tests/sum.test.ts',
      code: 'export const sum = (a: number, b: number) => a + b;',
    });
    expect(prompt).toContain('Язык: typescript');
    expect(prompt).toContain('Исходный файл: src/sum.ts');
    expect(prompt).toContain('Файл теста: tests/sum.test.ts');
    expect(prompt).toContain('```typescript');
    expect(prompt).toContain('export const sum');
  });
});

describe('truncateTestCode', () => {
  it('короткий код не трогает', () => {
    expect(truncateTestCode('const a = 1;')).toEqual({ text: 'const a = 1;', truncated: false });
  });

  it('длинный обрезает по строке и помечает', () => {
    const code = 'line\n'.repeat(20);
    const result = truncateTestCode(code, 30);
    expect(result.truncated).toBe(true);
    expect(result.text.endsWith('(код обрезан)')).toBe(true);
  });
});

describe('cleanTestCode', () => {
  it('снимает markdown-ограждение', () => {
    expect(cleanTestCode('```ts\nit("работает", () => {});\n```')).toBe('it("работает", () => {});');
  });

  it('снимает незакрытое ограждение и хвостовые переводы', () => {
    expect(cleanTestCode('```\nit("x", () => {});\n')).toBe('it("x", () => {});');
  });

  it('ответ без ограждения остаётся как есть', () => {
    expect(cleanTestCode('def test_x():\n    assert True')).toBe('def test_x():\n    assert True');
  });

  it('пустой ответ распознаётся', () => {
    expect(isEmptyTest(cleanTestCode('   \n\n'))).toBe(true);
    expect(isEmptyTest(cleanTestCode('it("x", () => {});'))).toBe(false);
  });
});

describe('suggestTestPath', () => {
  it('TypeScript: тест рядом в корневой tests/', () => {
    expect(suggestTestPath('src/sum.ts')).toBe('tests/sum.test.ts');
    expect(suggestTestPath('src/lib/deep.ts')).toBe('tests/deep.test.ts');
  });

  it('если исходник уже в tests/ — тест кладём туда же', () => {
    expect(suggestTestPath('tests/parser.ts')).toBe('tests/parser.test.ts');
  });

  it('JavaScript и расширения React сохраняются', () => {
    expect(suggestTestPath('src/Button.tsx')).toBe('tests/Button.test.tsx');
    expect(suggestTestPath('src/helper.js')).toBe('tests/helper.test.js');
  });

  it('Python: test_<имя>.py рядом с модулем', () => {
    expect(suggestTestPath('pkg/mod.py')).toBe('pkg/test_mod.py');
    expect(suggestTestPath('mod.py')).toBe('test_mod.py');
  });

  it('для самого теста путь не предлагаем', () => {
    expect(suggestTestPath('tests/sum.test.ts')).toBeNull();
    expect(suggestTestPath('src/sum.spec.ts')).toBeNull();
    expect(suggestTestPath('pkg/test_mod.py')).toBeNull();
  });
});
