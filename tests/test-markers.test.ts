import { describe, expect, it } from 'vitest';
import { testKindOf, testMarkerSignature, testMarkersFor } from '../src/renderer/core/test-markers';

const inside = (relative: string, languageId: string) => ({
  relative,
  absolute: `/p/${relative}`,
  languageId,
});

describe('testKindOf', () => {
  it('python-тест в проекте', () => {
    expect(testKindOf(inside('tests/test_api.py', 'python'))).toBe('python');
  });

  it('js-тест в проекте', () => {
    expect(testKindOf(inside('tests/api.test.ts', 'typescript'))).toBe('node');
  });

  it('обычный модуль — не тестовый, хотя в нём могут быть def test_', () => {
    expect(testKindOf(inside('src/api.py', 'python'))).toBeNull();
  });

  it('файл вне проекта не разбираем: относительного пути нет', () => {
    const outside = { relative: '/tmp/x.py', absolute: '/tmp/x.py', languageId: 'python' };
    expect(testKindOf(outside)).toBeNull();
  });

  it('язык решает: test_ в .ts-файле не делает его python-тестом', () => {
    expect(testKindOf(inside('tests/test_api.py', 'typescript'))).toBeNull();
  });
});

describe('testMarkersFor', () => {
  it('находит python-тесты', () => {
    const text = 'def test_one():\n    pass\n\ndef test_two():\n    pass\n';
    const markers = testMarkersFor(inside('tests/test_api.py', 'python'), text);
    expect(markers.length).toBe(2);
  });

  it('находит js-тесты', () => {
    const text = "it('работает', () => {});\ndescribe('группа', () => {});\n";
    const markers = testMarkersFor(inside('tests/api.test.ts', 'typescript'), text);
    expect(markers.length).toBeGreaterThan(0);
  });

  it('не тестовый файл — значков нет, текст не разбирается', () => {
    expect(testMarkersFor(inside('src/api.py', 'python'), 'def test_one(): pass')).toEqual([]);
  });
});

describe('testMarkerSignature', () => {
  it('правка меняет подпись: иначе новый тест не получил бы значок', () => {
    expect(testMarkerSignature('/p/a.py', 1)).not.toBe(testMarkerSignature('/p/a.py', 2));
  });

  it('постоянна без правок', () => {
    expect(testMarkerSignature('/p/a.py', 3)).toBe(testMarkerSignature('/p/a.py', 3));
  });
});
