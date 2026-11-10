import { describe, expect, it } from 'vitest';
import { shiftCursor } from '../src/shared/cursor-shift';
import type { TextEdit } from '../src/shared/edits';

const edit = (
  startLine: number,
  startColumn: number,
  endLine: number,
  endColumn: number,
  newText: string,
): TextEdit => ({
  startLine,
  startColumn,
  endLine,
  endColumn,
  newText,
});

/**
 * Курсор восстановленной сессии. Правка, пришедшая пока файл был закрыт,
 * раздвигает текст выше курсора — без сдвига человек вернулся бы на чужую
 * строку и искал бы свою работу глазами.
 */
describe('сдвиг курсора при правке за кадром', () => {
  it('правка выше курсора тянет его вниз', () => {
    expect(shiftCursor({ line: 10, column: 3 }, [edit(2, 1, 2, 1, 'a\nb\nc')])).toEqual({ line: 12, column: 3 });
  });

  it('правка ниже курсора его не трогает', () => {
    expect(shiftCursor({ line: 3, column: 5 }, [edit(10, 1, 10, 4, 'x')])).toEqual({ line: 3, column: 5 });
  });

  it('вставка на строку курсора сдвигает столбец, а не строку', () => {
    // '// ' — три знака с позиции 1, курсор встаёт сразу за ними.
    expect(shiftCursor({ line: 5, column: 1 }, [edit(5, 1, 5, 1, '// ')])).toEqual({ line: 5, column: 4 });
  });

  it('удаление строк выше поднимает курсор', () => {
    expect(shiftCursor({ line: 9, column: 2 }, [edit(2, 1, 5, 1, '')])).toEqual({ line: 6, column: 2 });
  });

  it('правка на строке курсора с удалением перед ним сдвигает столбец назад', () => {
    expect(shiftCursor({ line: 4, column: 10 }, [edit(4, 1, 4, 5, '')])).toEqual({ line: 4, column: 6 });
  });

  it('несколько правок считаются по порядку', () => {
    // '+1' от первой правки, '+2' от второй; курсор не должен считать одну из них дважды.
    expect(shiftCursor({ line: 8, column: 1 }, [edit(1, 1, 1, 1, 'a\nb'), edit(3, 1, 3, 1, 'c\nd\ne')])).toEqual({
      line: 11,
      column: 1,
    });
  });

  it('правка на первой строке не уводит курсор в нулевую', () => {
    // Курсор ровно в точке вставки: встаёт за последнюю вставленную строку.
    expect(shiftCursor({ line: 1, column: 1 }, [edit(1, 1, 1, 1, 'a\nb\nc')])).toEqual({ line: 3, column: 2 });
  });

  it('пустой список правок курсор не трогает', () => {
    expect(shiftCursor({ line: 7, column: 4 }, [])).toEqual({ line: 7, column: 4 });
  });
});
