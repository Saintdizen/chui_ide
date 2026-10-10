import { describe, expect, it } from 'vitest';
import { coveredRequest, isCovered, rememberRead } from '../src/shared/read-coverage';

/**
 * Учёт уже прочитанных диапазонов в агентном цикле.
 *
 * Агент не должен читать одно и то же место дважды: текст уже есть выше в ветке.
 * Проверяем границы — что именно считается покрытым и в каких случаях повтор
 * всё же разрешён (`force`, отсутствие диапазона, незакрытая верхняя граница).
 */

describe('isCovered', () => {
  it('диапазон внутри прочитанного — покрыт', () => {
    expect(isCovered([{ from: 1, to: 10 }], 3, 5)).toBe(true);
    expect(isCovered([{ from: 1, to: 10 }], 1, 10)).toBe(true);
  });

  it('запрос шире прочитанного — не покрыт', () => {
    expect(isCovered([{ from: 2, to: 10 }], 1, 5)).toBe(false);
    expect(isCovered([{ from: 1, to: 9 }], 5, 10)).toBe(false);
  });

  it('диапазоны не складываются: нужен один, покрывающий запрос целиком', () => {
    expect(
      isCovered(
        [
          { from: 1, to: 3 },
          { from: 5, to: 8 },
        ],
        2,
        7,
      ),
    ).toBe(false);
    expect(
      isCovered(
        [
          { from: 1, to: 5 },
          { from: 5, to: 9 },
        ],
        3,
        9,
      ),
    ).toBe(false);
    expect(isCovered([{ from: 1, to: 9 }], 3, 9)).toBe(true);
  });
});

describe('coveredRequest', () => {
  const reads = new Map([['/proj/a.ts', [{ from: 1, to: 100 }]]]);

  it('чужой инструмент — не наш случай', () => {
    expect(coveredRequest('search', '{"path":"/proj/a.ts","endLine":5}', reads)).toBeUndefined();
  });

  it('битый JSON — не разбираем', () => {
    expect(coveredRequest('read_file', '{не json', reads)).toBeUndefined();
  });

  it('без endLine верхняя граница неизвестна — повтор разрешён', () => {
    expect(coveredRequest('read_file', '{"path":"/proj/a.ts","startLine":1}', reads)).toBeUndefined();
  });

  it('endLine не целое — не считаем диапазоном', () => {
    expect(coveredRequest('read_file', '{"path":"/proj/a.ts","endLine":5.5}', reads)).toBeUndefined();
  });

  it('force явно просит перечитать', () => {
    expect(coveredRequest('read_file', '{"path":"/proj/a.ts","endLine":5,"force":true}', reads)).toBeUndefined();
  });

  it('диапазон уже прочитан — возвращаем его', () => {
    const hit = coveredRequest('read_file', '{"path":"/proj/a.ts","startLine":10,"endLine":20}', reads);
    expect(hit).toEqual({ path: '/proj/a.ts', from: 10, to: 20 });
  });

  it('без startLine начало считается с первой строки', () => {
    const hit = coveredRequest('read_file', '{"path":"/proj/a.ts","endLine":20}', reads);
    expect(hit).toEqual({ path: '/proj/a.ts', from: 1, to: 20 });
  });

  it('диапазон вне прочитанного — не покрыт', () => {
    expect(coveredRequest('read_file', '{"path":"/proj/a.ts","startLine":1,"endLine":200}', reads)).toBeUndefined();
  });

  it('неизвестный файл — не покрыт', () => {
    expect(coveredRequest('read_file', '{"path":"/proj/b.ts","startLine":1,"endLine":5}', reads)).toBeUndefined();
  });

  it('перевёрнутый диапазон схлопывается к одной строке', () => {
    const hit = coveredRequest('read_file', '{"path":"/proj/a.ts","startLine":50,"endLine":10}', reads);
    expect(hit).toEqual({ path: '/proj/a.ts', from: 50, to: 50 });
  });
});

describe('rememberRead', () => {
  it('копит диапазоны по одному файлу', () => {
    const reads = new Map<string, Array<{ from: number; to: number }>>();
    rememberRead(reads, { path: '/a.ts', from: 1, to: 5 });
    rememberRead(reads, { path: '/a.ts', from: 10, to: 20 });
    rememberRead(reads, { path: '/b.ts', from: 1, to: 3 });

    expect(reads.get('/a.ts')).toEqual([
      { from: 1, to: 5 },
      { from: 10, to: 20 },
    ]);
    expect(reads.get('/b.ts')).toEqual([{ from: 1, to: 3 }]);
  });
});
