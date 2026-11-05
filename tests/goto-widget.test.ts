// biome-ignore-all lint/suspicious/noExplicitAny: узлы мини-DOM приходят из
// заглушки DOM — тип у них шире настоящего намеренно, вне этого файла не нужен.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GotoLineWidget, parseLineNumber } from '../src/renderer/editor/widgets/goto-widget';
import { installMiniDom } from './helpers/mini-dom';

/**
 * Переход к строке по номеру, Ctrl+G (`editor/widgets/goto-widget.ts`).
 *
 * Ввод разбирается прощающе, и это главное в виджете: «412» в файле из 100 строк —
 * не ошибка, а просьба встать в конец. Поэтому половина тестов — про разбор и
 * прижатие к границам, а половина — про сам вид: подстановка текущей строки,
 * подсказка, Enter и Escape.
 */

describe('номер строки из ввода', () => {
  it('обычный номер проходит как есть', () => {
    expect(parseLineNumber('12', 100)).toBe(12);
  });

  it('пробелы по краям не мешают', () => {
    expect(parseLineNumber('  7  ', 100)).toBe(7);
  });

  it('номер за концом файла прижимается к последней строке', () => {
    // Человек хотел ближе к концу, а не «получил отказ».
    expect(parseLineNumber('412', 100)).toBe(100);
  });

  it('ноль и отрицательное — первая строка', () => {
    expect(parseLineNumber('0', 100)).toBe(1);
    // Минус не проходит проверку цифр и приходит как отказ — так и задумано.
    expect(parseLineNumber('-5', 100)).toBeNull();
  });

  it('не число — отказ, а не «первая строка»', () => {
    expect(parseLineNumber('abc', 100)).toBeNull();
    expect(parseLineNumber('12a', 100)).toBeNull();
    expect(parseLineNumber('', 100)).toBeNull();
    expect(parseLineNumber('1.5', 100)).toBeNull();
  });

  it('в файле из одной строки любой номер даёт первую', () => {
    expect(parseLineNumber('99', 1)).toBe(1);
  });

  it('пустой файл не даёт нулевой строки', () => {
    // `lineCount` у пустого документа всё равно 1 — нулевой строки не существует.
    expect(parseLineNumber('5', 0)).toBe(1);
  });
});

/** Буфер и контроллер — заглушки: виджет только читает номера и водит каретку. */
function setup(text = 'one\ntwo\nthree\nfour') {
  const lines = text.split('\n');
  const buffer = {
    lineCount: lines.length,
    lineAt: (offset: number) => {
      let start = 0;
      for (let index = 0; index < lines.length; index += 1) {
        const end = start + (lines[index] ?? '').length;
        if (offset <= end) return index + 1;
        start = end + 1;
      }
      return lines.length;
    },
    lineStart: (line: number) => {
      let start = 0;
      for (let index = 0; index < line - 1; index += 1) start += (lines[index] ?? '').length + 1;
      return start;
    },
    // Столбец прижимается к концу строки — так же, как настоящий `TextBuffer.offsetAt`.
    offsetAt: (position: { line: number; column: number }) => {
      const index = Math.min(Math.max(1, position.line), lines.length) - 1;
      let start = 0;
      for (let i = 0; i < index; i += 1) start += (lines[i] ?? '').length + 1;
      return start + Math.min(Math.max(0, position.column - 1), (lines[index] ?? '').length);
    },
  };
  const selected: [number, number][] = [];
  const controller = {
    caret: 0,
    selectRange: (from: number, to: number) => selected.push([from, to]),
  };
  const revealed: number[] = [];
  const opened: [string, number, number][] = [];
  const deps = {
    projectFiles: async () => ['src/main.ts', 'src/app.ts', 'src/core/paths.ts', 'tests/goto-widget.test.ts'],
    openPath: (path: string, line: number, column: number) => opened.push([path, line, column]),
  };
  const view = {
    element: document.createElement('div'),
    revealOffset: (offset: number) => revealed.push(offset),
  };

  const widget = new GotoLineWidget(view as never, controller as never, buffer as never, deps);
  const root = (view.element as unknown as { querySelector(s: string): any }).querySelector('.own-editor-goto');
  const input = root.querySelector('.own-editor-goto-input');
  const list = root.querySelector('.own-editor-goto-list');
  const hint = root.querySelector('.own-editor-goto-hint');
  return { widget, view, controller, root, input, list, hint, selected, revealed, buffer, opened, deps };
}

function press(input: any, key: string): void {
  for (const handler of input.handlers.keydown ?? []) {
    handler({ key, preventDefault() {} });
  }
}

function type(input: any, value: string): void {
  input.value = value;
  for (const handler of input.handlers.input ?? []) handler({});
}

describe('панель перехода к строке', () => {
  beforeEach(() => {
    installMiniDom();
  });

  it('создаётся скрытой и показывает себя по команде', () => {
    const { widget, root } = setup();
    expect(root.hidden).toBe(true);

    widget.show();

    expect(root.hidden).toBe(false);
    expect(widget.isVisible).toBe(true);
  });

  it('в поле сразу стоит текущая строка — соседнюю дописать быстрее', () => {
    const { widget, input, controller, buffer } = setup();
    controller.caret = buffer.lineStart(3);

    widget.show();

    expect(input.value).toBe('3');
  });

  it('Enter встаёт на строку и прокручивает к ней', () => {
    const { widget, input, selected, revealed } = setup();
    widget.show();
    input.value = '4';

    press(input, 'Enter');

    // «one\ntwo\nthree\n» — 14 символов, строка 4 начинается со смещения 14.
    expect(selected).toEqual([[14, 14]]);
    expect(revealed).toEqual([14]);
  });

  it('номер за концом файла встаёт на последнюю строку', () => {
    const { widget, input, selected } = setup();
    widget.show();
    input.value = '999';

    press(input, 'Enter');

    expect(selected).toEqual([[14, 14]]);
  });

  it('текст без номера — это путь, а не опечатка: каретку не трогаем, файл открываем', () => {
    // Раньше здесь стояло «не число не сдвигает каретку и оставляет панель открытой»:
    // поле принимало только номер, и `строка` было опечаткой. Теперь поле понимает
    // `файл:строка`, поэтому текст без номера — это имя файла, и оно уходит в
    // приложение. Каретку в текущем файле при этом не двигаем.
    const { widget, input, selected, opened } = setup();
    widget.show();
    input.value = 'строка';

    press(input, 'Enter');

    expect(selected).toEqual([]);
    expect(opened).toEqual([['строка', 1, 1]]);
  });

  it('опечатка в номере панель не закрывает', () => {
    // `a.ts:0` — вот это опечатка: номер есть, но невозможный. Закрывать панель
    // нельзя, иначе открывать заново.
    const { widget, input, selected, root, opened } = setup();
    widget.show();
    input.value = 'src/a.ts:0';

    press(input, 'Enter');

    expect(selected).toEqual([]);
    expect(opened).toEqual([]);
    expect(root.hidden).toBe(false);
  });

  it('набор пути показывает имена файлов проекта', async () => {
    const { widget, input, list } = setup();
    widget.show();
    // Список грузится в фоне: дожидаемся его.
    await Promise.resolve();
    await Promise.resolve();

    type(input, 'src/m');
    expect(list.hidden).toBe(false);
    expect(widget.suggestionList).toEqual(['src/main.ts']);
  });

  it('номер пути не мешает подсказке: ищем по пути до двоеточия', async () => {
    const { widget, input } = setup();
    widget.show();
    await Promise.resolve();
    await Promise.resolve();

    type(input, 'src/main.ts:12');
    expect(widget.suggestionList).toEqual(['src/main.ts']);
  });

  it('голый номер подсказок не показывает — подсказывать нечего', async () => {
    const { widget, input, list } = setup();
    widget.show();
    await Promise.resolve();
    await Promise.resolve();

    type(input, '12');
    expect(widget.suggestionList).toEqual([]);
    expect(list.hidden).toBe(true);
  });

  it('Enter по выбранной подсказке подставляет путь и сохраняет номер', async () => {
    const { widget, input, opened } = setup();
    widget.show();
    await Promise.resolve();
    await Promise.resolve();

    type(input, 'src/m:7');
    press(input, 'ArrowDown'); // выбор первой подсказки
    press(input, 'Enter');

    // Первый Enter только выбрал файл — переход по нему второй.
    expect(input.value).toBe('src/main.ts:7');
    expect(opened).toEqual([]);
    press(input, 'Enter');
    expect(opened).toEqual([['src/main.ts', 7, 1]]);
  });

  it('файл с номером открывается через приложение, а не в текущем буфере', () => {
    const { widget, input, selected, opened } = setup();
    widget.show();

    type(input, 'src/core/paths.ts:12');
    press(input, 'Enter');

    expect(selected).toEqual([]);
    expect(opened).toEqual([['src/core/paths.ts', 12, 1]]);
    expect(widget.isVisible).toBe(false);
  });

  it('файл со столбцом передаёт и его', () => {
    const { widget, input, opened } = setup();
    widget.show();

    type(input, 'src/app.ts:3:5');
    press(input, 'Enter');

    expect(opened).toEqual([['src/app.ts', 3, 5]]);
  });

  it('файл без номера — с начала', () => {
    const { widget, input, opened } = setup();
    widget.show();

    type(input, 'src/app.ts');
    press(input, 'Enter');

    expect(opened).toEqual([['src/app.ts', 1, 1]]);
  });

  it('Escape закрывает и зовёт возврат фокуса', () => {
    const { widget, input, root } = setup();
    const onClose = vi.fn();
    widget.onClose = onClose;
    widget.show();

    press(input, 'Escape');

    expect(root.hidden).toBe(true);
    expect(onClose).toHaveBeenCalled();
  });

  it('подсказка говорит о прижатии номера за концом файла', () => {
    const { widget, input, root } = setup();
    widget.show();
    const hint = root.querySelector('.own-editor-goto-hint');

    type(input, '2');
    expect(hint.textContent).toBe('из 4');

    type(input, '999');
    // Знать о прижатии стоит: это не ошибка, но человек должен видеть, куда попадёт.
    expect(hint.textContent).toContain('последняя');

    // Текст без числа — уже не «мусор в поле», а путь: подсказка показывает,
    // что именно откроется.
    type(input, 'ой');
    expect(hint.textContent).toContain('ой');
  });
});
