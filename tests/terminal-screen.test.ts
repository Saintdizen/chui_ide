import { describe, expect, it } from 'vitest';
import { Terminal } from '../src/renderer/terminal/core/screen';

/**
 * Модель экрана: печать, перенос, прокрутка, курсор и стирание. Проверяется без DOM —
 * экран читается как строки ячеек. Собираем через `write`, как это делает настоящий
 * вывод pty; вспомогательные функции дают готовый текст строки для сверки.
 */

/** Текст строки без хвостовых пробелов: так удобнее сверять вывод. */
const row = (term: Terminal, index: number): string =>
  (term.line(index)?.cells ?? [])
    .map((cell) => cell.chars)
    .join('')
    .replace(/\s+$/, '');

describe('Terminal: печать', () => {
  it('знаки занимают последовательные клетки, курсор сдвигается', () => {
    const term = new Terminal(10, 3);
    term.write('hi');
    expect(row(term, 0)).toBe('hi');
    expect(term.cursor).toEqual({ x: 2, y: 0 });
  });

  it('широкий знак занимает две клетки', () => {
    const term = new Terminal(10, 3);
    term.write('あ');
    const cells = term.line(0)?.cells ?? [];
    expect(cells[0]).toMatchObject({ chars: 'あ', width: 2 });
    expect(cells[1]).toMatchObject({ chars: '', width: 0 });
    expect(term.cursor.x).toBe(2);
  });

  it('комбинирующий знак дописывается к знаку слева', () => {
    const term = new Terminal(10, 3);
    term.write('e\u0301');
    expect(term.line(0)?.cells[0]?.chars).toBe('e\u0301');
    expect(term.cursor.x).toBe(1);
  });

  it('знак за правым краем переносится на следующую строку', () => {
    const term = new Terminal(5, 3);
    term.write('abcdef');
    expect(row(term, 0)).toBe('abcde');
    expect(row(term, 1)).toBe('f');
  });
});

describe('Terminal: возврат строки и перевод строки', () => {
  it('CR возвращает курсор, LF переводит строку', () => {
    const term = new Terminal(10, 3);
    term.write('ab\r\ncd');
    expect(row(term, 0)).toBe('ab');
    expect(row(term, 1)).toBe('cd');
    expect(term.cursor).toEqual({ x: 2, y: 1 });
  });

  it('на нижней строке доска прокручивается, а верх уходит в историю', () => {
    const term = new Terminal(5, 2);
    term.write('a\r\nb\r\nc');
    expect(
      term
        .history()
        .map((line) => line.cells[0]?.chars)
        .join(''),
    ).toBe('a');
    expect(row(term, 0)).toBe('b');
    expect(row(term, 1)).toBe('c');
  });
});

describe('Terminal: курсор и стирание', () => {
  it('CUP ставит курсор по строке и столбцу (нумерация с единицы)', () => {
    const term = new Terminal(10, 5);
    term.write('\x1b[2;3H');
    expect(term.cursor).toEqual({ x: 2, y: 1 });
  });

  it('ED 2 очищает экран целиком', () => {
    const term = new Terminal(10, 3);
    term.write('текст\x1b[2J');
    expect(row(term, 0)).toBe('');
  });

  it('EL 0 стирает от курсора до конца строки', () => {
    const term = new Terminal(10, 3);
    term.write('abcdef\r\x1b[3G\x1b[K');
    expect(row(term, 0)).toBe('ab');
  });

  it('управление видимостью курсора меняет режим', () => {
    const term = new Terminal(10, 3);
    term.write('\x1b[?25l');
    expect(term.cursorVisible).toBe(false);
    term.write('\x1b[?25h');
    expect(term.cursorVisible).toBe(true);
  });

  it('DSR 6 отдаёт позицию курсора ответом', () => {
    const replies: string[] = [];
    const term = new Terminal(10, 5, (data) => replies.push(data));
    term.write('\x1b[2;4H\x1b[6n');
    expect(replies).toEqual(['\x1b[2;4R']);
  });
});

describe('Terminal: альтернативный экран', () => {
  it('переключение на альтернативную доску прячет основную, возврат — восстанавливает', () => {
    const term = new Terminal(10, 3);
    term.write('x\x1b[?1049h');
    expect(row(term, 0)).toBe('');
    term.write('y');
    expect(row(term, 0)).toBe('y');
    term.write('\x1b[?1049l');
    expect(row(term, 0)).toBe('x');
  });
});

describe('Terminal: область прокрутки', () => {
  it('прокрутка идёт внутри заданной области, не задевая края', () => {
    const term = new Terminal(5, 5);
    // Строки-маркеры на краях, область — строки 2..4, курсор ставим в её низ.
    term.write('\x1b[1;1Htop');
    term.write('\x1b[5;1Hbot');
    term.write('\x1b[2;4r');
    term.write('\x1b[4;1H\r\nnew');
    // Верхняя и нижняя строки экрана остаются на месте, прокрутка — только внутри.
    expect(row(term, 0)).toBe('top');
    expect(row(term, 3)).toBe('new');
    expect(row(term, 4)).toBe('bot');
  });
});

describe('Terminal: режимы мыши', () => {
  it('по умолчанию мышь не запрошена', () => {
    const term = new Terminal(10, 3);
    expect(term.mouseTracking).toBe('none');
    expect(term.mouseSgr).toBe(false);
  });

  it('DECSET выбирает режим, DECRST его снимает', () => {
    const term = new Terminal(10, 3);
    term.write('\x1b[?1000h');
    expect(term.mouseTracking).toBe('click');
    term.write('\x1b[?1002h');
    expect(term.mouseTracking).toBe('drag');
    term.write('\x1b[?1003h');
    expect(term.mouseTracking).toBe('move');
    term.write('\x1b[?1003l');
    expect(term.mouseTracking).toBe('none');
  });

  it('форма события SGR помнится отдельно от режима', () => {
    const term = new Terminal(10, 3);
    term.write('\x1b[?1006h');
    expect(term.mouseSgr).toBe(true);
    term.write('\x1b[?1006l');
    expect(term.mouseSgr).toBe(false);
  });

  it('старый код ?9 включает самый узкий режим мыши', () => {
    const term = new Terminal(10, 3);
    term.write('\x1b[?9h');
    expect(term.mouseTracking).toBe('click');
  });
});

describe('Terminal: смена размера', () => {
  it('столбцы дополняются при расширении', () => {
    const term = new Terminal(5, 3);
    term.write('abc');
    term.resize(8, 3);
    expect(term.line(0)?.cells.length).toBe(8);
    expect(row(term, 0)).toBe('abc');
  });

  it('строки добавляются снизу при увеличении высоты', () => {
    const term = new Terminal(5, 2);
    term.resize(5, 4);
    expect(term.rows).toBe(4);
    expect(term.line(3)?.cells.length).toBe(5);
  });
});
