import { describe, expect, it } from 'vitest';
import { installSuggestions } from '../src/shared/import-install';
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
