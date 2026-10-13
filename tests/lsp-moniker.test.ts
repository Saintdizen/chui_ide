import { describe, expect, it } from 'vitest';
import { toMonikers } from '../src/shared/lsp-moniker';

/**
 * Разбор моникеров (`textDocument/moniker`). Проверяем терпимость: сервер вправе прислать
 * несколько схем, а битую запись (без схемы или пути) мы пропускаем — связывать символ
 * нечем, и такая строка в списке была бы пустой.
 */

describe('toMonikers', () => {
  it('разбирает записи сервера и порядок сохраняет', () => {
    const monikers = toMonikers([
      { scheme: 'tsc', identifier: 'tsc:/proj/a.ts:Util.fn', unique: 'document' },
      { scheme: 'lsif', identifier: 'lsif:/proj/a.ts:12', unique: 'project' },
    ]);

    expect(monikers).toEqual([
      { scheme: 'tsc', identifier: 'tsc:/proj/a.ts:Util.fn', unique: false },
      { scheme: 'lsif', identifier: 'lsif:/proj/a.ts:12', unique: true },
    ]);
  });

  it('уникальность — уровень выше одного документа', () => {
    expect(toMonikers([{ scheme: 'tsc', identifier: 'x', unique: 'project' }])[0]!.unique).toBe(true);
    expect(toMonikers([{ scheme: 'tsc', identifier: 'x', unique: 'global' }])[0]!.unique).toBe(true);
    expect(toMonikers([{ scheme: 'tsc', identifier: 'x', unique: 'document' }])[0]!.unique).toBe(false);
    expect(toMonikers([{ scheme: 'tsc', identifier: 'x' }])[0]!.unique).toBe(false);
  });

  it('записи без схемы или пути пропускаются', () => {
    expect(toMonikers([{ scheme: '', identifier: 'x' }])).toEqual([]);
    expect(toMonikers([{ scheme: 'tsc', identifier: '' }])).toEqual([]);
    expect(toMonikers([null, {}, { scheme: 'tsc' }])).toEqual([]);
  });

  it('не-массив — пустой список', () => {
    expect(toMonikers(null)).toEqual([]);
    expect(toMonikers({ scheme: 'tsc' } as unknown)).toEqual([]);
  });
});
