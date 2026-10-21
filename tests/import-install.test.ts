import { describe, expect, it } from 'vitest';
import { installMenuItems, installSuggestions, objectsWord } from '../src/shared/import-install';
import { packageForModule } from '../src/shared/python-packages';
import type { ImportRef } from '../src/shared/imports';

/**
 * Отбор предложений «поставить пакет» — общий для Python и Node.
 * Разница только в переводе имени модуля в имя пакета, поэтому проверяем оба случая.
 */

const ref = (top: string, line: number): ImportRef => ({
  module: top,
  top,
  line,
  startColumn: 8,
  endColumn: 8 + top.length,
});

describe('installSuggestions', () => {
  it('берёт только импорты запрошенных строк', () => {
    const refs = [ref('yaml', 1), ref('requests', 2)];
    expect(installSuggestions(refs, new Set([1]))).toEqual([{ module: 'yaml', package: 'yaml' }]);
  });

  it('перевод модуля в пакет применяется, когда задан', () => {
    const refs = [ref('yaml', 1), ref('PIL', 1)];
    expect(installSuggestions(refs, new Set([1]), packageForModule)).toEqual([
      { module: 'yaml', package: 'PyYAML' },
      { module: 'PIL', package: 'Pillow' },
    ]);
  });

  it('без перевода имя пакета совпадает с модулем (Node)', () => {
    const refs = [ref('zod', 3), ref('@scope/pkg', 4)];
    expect(installSuggestions(refs, new Set([3, 4]))).toEqual([
      { module: 'zod', package: 'zod' },
      { module: '@scope/pkg', package: '@scope/pkg' },
    ]);
  });

  it('один и тот же пакет не предлагается дважды', () => {
    const refs = [ref('yaml', 1), ref('yaml', 1)];
    expect(installSuggestions(refs, new Set([1]), packageForModule)).toHaveLength(1);
  });

  it('повтор после перевода тоже схлопывается', () => {
    // `yaml` и `YAML` — один и тот же пакет после перевода.
    const refs = [ref('yaml', 1), ref('YAML', 1)];
    expect(installSuggestions(refs, new Set([1]), packageForModule)).toEqual([{ module: 'yaml', package: 'PyYAML' }]);
  });

  it('ничего не предложить — пустой список', () => {
    expect(installSuggestions([ref('yaml', 1)], new Set([5]))).toEqual([]);
    expect(installSuggestions([], new Set([1]))).toEqual([]);
  });

  it('диапазон строк: предложения для всех строк запроса', () => {
    const refs = [ref('zod', 1), ref('axios', 2), ref('lodash', 3)];
    expect(installSuggestions(refs, new Set([2, 3])).map((item) => item.package)).toEqual(['axios', 'lodash']);
  });
});

describe('objectsWord', () => {
  it('склоняет по числу: 1, 2, 5', () => {
    expect([1, 2, 5, 21, 22, 25].map(objectsWord)).toEqual([
      'объект',
      'объекта',
      'объектов',
      'объект',
      'объекта',
      'объектов',
    ]);
  });

  it('11–14 — всегда «объектов», хотя кончаются на 1–4', () => {
    expect([11, 12, 13, 14, 111, 114].map(objectsWord)).toEqual([
      'объектов',
      'объектов',
      'объектов',
      'объектов',
      'объектов',
      'объектов',
    ]);
  });

  it('ноль — «объектов»', () => {
    expect(objectsWord(0)).toBe('объектов');
  });
});

describe('installMenuItems', () => {
  const suggestions = [{ module: 'yaml', package: 'PyYAML' }];

  it('Python зовёт pip и пишет это в подписи', () => {
    const items = installMenuItems(suggestions, true, () => {});
    expect(items[0]?.title).toBe('Установить пакет PyYAML (pip)');
    expect(items[0]?.category).toBe('Python');
  });

  it('Node зовёт npm', () => {
    const items = installMenuItems([{ module: 'zod', package: 'zod' }], false, () => {});
    expect(items[0]?.title).toBe('Установить пакет zod (npm)');
    expect(items[0]?.category).toBe('Node');
  });

  it('id различает менеджеры: тот же пакет в Python и Node — не одно действие', () => {
    const asPython = installMenuItems(suggestions, true, () => {})[0]?.id;
    const asNode = installMenuItems(suggestions, false, () => {})[0]?.id;
    expect(asPython).not.toBe(asNode);
  });

  it('run зовёт установку с языком, ради которого собран пункт', () => {
    const calls: Array<[string, boolean]> = [];
    const items = installMenuItems(suggestions, true, (pkg, python) => calls.push([pkg, python]));
    items[0]?.run();
    expect(calls).toEqual([['PyYAML', true]]);
  });
});
