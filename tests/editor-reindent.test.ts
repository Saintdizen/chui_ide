import { describe, expect, it } from 'vitest';
import { indentWidth, reindentPasted } from '../src/renderer/editor/input/reindent';

const options = (over: Partial<{ baseIndent: string; tabSize: number; shiftFirstLine: boolean }> = {}) => ({
  baseIndent: '',
  tabSize: 4,
  ...over,
});

describe('indentWidth', () => {
  it('пробелы считаются поштучно', () => {
    expect(indentWidth('    x', 4)).toBe(4);
    expect(indentWidth('  x', 4)).toBe(2);
    expect(indentWidth('x', 4)).toBe(0);
  });

  it('табуляция — прыжок к следующему кратному', () => {
    expect(indentWidth('\tx', 4)).toBe(4);
    expect(indentWidth('\t\tx', 4)).toBe(8);
    expect(indentWidth(' \tx', 4)).toBe(4);
    expect(indentWidth('  \tx', 4)).toBe(4);
    expect(indentWidth('    \tx', 4)).toBe(8);
  });
});

describe('reindentPasted', () => {
  it('снимает общий отступ блока и ставит отступ места вставки', () => {
    const text = '    if (x) {\n        y();\n    }';
    expect(reindentPasted(text, options({ baseIndent: '  ' }))).toBe('  if (x) {\n      y();\n  }');
  });

  it('относительная вложенность сохраняется', () => {
    const text = '  a\n      b\n    c';
    expect(reindentPasted(text, options({ baseIndent: '    ' }))).toBe('    a\n        b\n      c');
  });

  it('блок без общего отступа только сдвигается целиком', () => {
    const text = 'if (x) {\n    y();\n}';
    expect(reindentPasted(text, options({ baseIndent: '  ' }))).toBe('  if (x) {\n      y();\n  }');
  });

  it('однострочная вставка не трогается', () => {
    expect(reindentPasted('  a', options({ baseIndent: '    ' }))).toBe('  a');
    expect(reindentPasted('a', options())).toBe('a');
  });

  it('первая строка не сдвигается, когда каретка посреди текста', () => {
    // Первая строка продолжает текущую строку — отступ встал бы в её середину.
    const text = '  a\n    b';
    expect(reindentPasted(text, options({ baseIndent: '  ', shiftFirstLine: false }))).toBe('  a\n    b');
  });

  it('первая строка сдвигается, когда каретка в ведущих пробелах', () => {
    const text = '  a\n    b';
    expect(reindentPasted(text, options({ baseIndent: '    ', shiftFirstLine: true }))).toBe('    a\n      b');
  });

  it('табуляции в блоке приводятся к пробелам', () => {
    const text = '\ta\n\t\tb';
    expect(reindentPasted(text, options({ baseIndent: '  ' }))).toBe('  a\n      b');
  });

  it('табуляция и пробелы сравниваются в колонках', () => {
    // Восемь пробелов и две табуляции — один и тот же отступ; общий съедается, остаётся вложенность.
    const text = '        a\n\t\t\tb';
    expect(reindentPasted(text, options({ baseIndent: '' }))).toBe('a\n    b');
  });

  it('пустые строки остаются пустыми, хвостовые пробелы уходят', () => {
    const text = '  a\n   \n  b';
    expect(reindentPasted(text, options({ baseIndent: '  ' }))).toBe('  a\n\n  b');
  });

  it('переносы CRLF приводятся к LF', () => {
    expect(reindentPasted('  a\r\n    b', options({ baseIndent: '' }))).toBe('a\n  b');
  });

  it('текст из одних пустых строк не меняется', () => {
    expect(reindentPasted('   \n  \n', options({ baseIndent: '    ' }))).toBe('   \n  \n');
  });

  it('одиночный перевод строки не ломает', () => {
    expect(reindentPasted('\n', options({ baseIndent: '  ' }))).toBe('\n');
  });

  it('концевой перевод строки сохраняется', () => {
    expect(reindentPasted('  a\n  b\n', options({ baseIndent: '' }))).toBe('a\nb\n');
  });
});
