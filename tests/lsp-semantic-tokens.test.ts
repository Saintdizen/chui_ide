import { describe, expect, it } from 'vitest';
import {
  STANDARD_LEGEND,
  STANDARD_TOKEN_MODIFIERS,
  STANDARD_TOKEN_TYPES,
  decodeSemanticTokens,
  semanticTokenRole,
} from '../src/shared/lsp-semantic-tokens';

/**
 * Разбор семантических токенов. Главное здесь — дельта-кодирование: позиция каждого токена
 * записана сдвигом от предыдущего, и ошибка в нём тихо сдвигает всю подсветку ниже. Поэтому
 * проверяем и смену строки (столбец берётся заново), и продолжение в той же строке (столбец
 * прибавляется), и маску модификаторов.
 */

const legend = STANDARD_LEGEND;

describe('decodeSemanticTokens', () => {
  it('разбирает токены и переводит координаты в 1-based', () => {
    // Строка 0, столбец 4, длина 3, тип «function» (индекс 12), без модификаторов.
    const data = [0, 4, 3, 12, 0];
    const [token] = decodeSemanticTokens(data, legend);

    expect(token).toMatchObject({ line: 1, startColumn: 5, endColumn: 8, type: 'function' });
    expect(token!.modifiers).toEqual([]);
  });

  it('сдвиг по строке берёт столбец заново, сдвиг по столбцу — прибавляет', () => {
    const data = [
      0,
      4,
      3,
      12,
      0, // строка 0, столбцы 4..7
      0,
      6,
      2,
      8,
      0, // та же строка, столбцы 10..12 (4+6)
      2,
      3,
      1,
      17,
      0, // строка 2, столбцы 3..4
    ];
    const tokens = decodeSemanticTokens(data, legend);

    expect(tokens.map((t) => [t.line, t.startColumn, t.endColumn])).toEqual([
      [1, 5, 8],
      [1, 11, 13],
      [3, 4, 5],
    ]);
  });

  it('читает модификаторы по маске', () => {
    const readOnly = STANDARD_TOKEN_MODIFIERS.indexOf('readonly'); // бит 2
    const staticBit = STANDARD_TOKEN_MODIFIERS.indexOf('static'); // бит 3
    const data = [0, 0, 3, 8, (1 << readOnly) | (1 << staticBit)];
    const [token] = decodeSemanticTokens(data, legend);

    expect(token!.modifiers).toEqual(['readonly', 'static']);
  });

  it('принимает и массив, и объект с data', () => {
    const data = [0, 0, 1, 15, 0];
    expect(decodeSemanticTokens(data, legend)).toHaveLength(1);
    expect(decodeSemanticTokens({ data }, legend)).toHaveLength(1);
  });

  it('тип вне легенды пропускается, остальные остаются', () => {
    const data = [
      0,
      0,
      2,
      999,
      0, // тип вне легенды
      0,
      5,
      2,
      15,
      0, // keyword
    ];
    const tokens = decodeSemanticTokens(data, legend);

    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.type).toBe('keyword');
  });

  it('битые ответы — пустой список', () => {
    expect(decodeSemanticTokens(null, legend)).toEqual([]);
    expect(decodeSemanticTokens([], legend)).toEqual([]);
    expect(decodeSemanticTokens([0, 1, 2], legend)).toEqual([]); // не кратно пяти
    expect(decodeSemanticTokens([0, 1, 2, 3, 'x'], legend)).toEqual([]);
    expect(decodeSemanticTokens({}, legend)).toEqual([]);
  });

  it('отрицательная длина — ответ не разбираем', () => {
    expect(decodeSemanticTokens([0, 0, -1, 12, 0], legend)).toEqual([]);
  });
});

describe('semanticTokenRole', () => {
  it('сопоставляет типы сервера с ролями палитры', () => {
    expect(semanticTokenRole('class')).toBe('type');
    expect(semanticTokenRole('typeParameter')).toBe('type');
    expect(semanticTokenRole('variable')).toBe('identifier');
    expect(semanticTokenRole('parameter')).toBe('identifier');
    expect(semanticTokenRole('method')).toBe('function');
    expect(semanticTokenRole('comment')).toBe('comment');
    expect(semanticTokenRole('number')).toBe('number');
    expect(semanticTokenRole('keyword')).toBe('keyword');
  });

  it('оператор бесцветен, неизвестный тип тоже', () => {
    expect(semanticTokenRole('operator')).toBeNull();
    expect(semanticTokenRole('что-то своё')).toBeNull();
  });

  it('каждый объявленный тип имеет понятную роль или осознанно бесцветен', () => {
    for (const type of STANDARD_TOKEN_TYPES) {
      const role = semanticTokenRole(type);
      expect(role === null || typeof role === 'string').toBe(true);
    }
  });
});
