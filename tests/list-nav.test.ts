import { describe, expect, it } from 'vitest';
import { LIST_PAGE, listMove, optionId, typeaheadIndex } from '../src/renderer/core/list-nav';

/**
 * Клавиши любого списка с ролью `listbox`.
 *
 * Раньше это правила жили (или не жили) в трёх местах отдельно: палитра команд,
 * быстрое открытие, выпадающий список. Общее у них было только `↑/↓`, а
 * `Home`/`End`, страницы и переход по букве какой-то из трёх забывал.
 *
 * Здесь проверяется само правило: какая строка станет текущей. Как это нарисуется
 * и что скажет читалка — забота вида.
 */

describe('стрелки: обёртка, а не упор в край', () => {
  it('↓ вниз, ↑ вверх', () => {
    expect(listMove('ArrowDown', 0, 3)).toEqual({ kind: 'to', index: 1 });
    expect(listMove('ArrowUp', 1, 3)).toEqual({ kind: 'to', index: 0 });
  });

  it('↓ на последней переходит на первую', () => {
    // Упор в край человек читает как поломку: «дальше ничего?». В палитре
    // команд вариантов десятки, и край — обычное место.
    expect(listMove('ArrowDown', 2, 3)).toEqual({ kind: 'to', index: 0 });
    expect(listMove('ArrowUp', 0, 3)).toEqual({ kind: 'to', index: 2 });
  });
});

describe('края и страницы', () => {
  it('Home в начало, End в конец', () => {
    expect(listMove('Home', 2, 5)).toEqual({ kind: 'to', index: 0 });
    expect(listMove('End', 2, 5)).toEqual({ kind: 'to', index: 4 });
  });

  it('страницы не перелетают край', () => {
    // Без зажима `PageDown` у конца дал бы индекс за списком, и подсветка
    // уехала бы с экрана.
    expect(listMove('PageDown', 1, 5, 3)).toEqual({ kind: 'to', index: 4 });
    expect(listMove('PageUp', 1, 5, 3)).toEqual({ kind: 'to', index: 0 });
    expect(listMove('PageDown', 0, 5, LIST_PAGE)).toEqual({ kind: 'to', index: 4 });
  });
});

describe('что НЕ наше — не перехватывается', () => {
  it('пустой список — ни одного хода', () => {
    expect(listMove('ArrowDown', 0, 0)).toBeNull();
  });

  it('пробел — не переход по букве', () => {
    // В списках выбора пробел выбирает. Перехвати мы его — выбрать было бы нечем.
    expect(listMove(' ', 0, 3)).toBeNull();
  });

  it('Enter и Escape — не наша работа', () => {
    // Ими управляет сам вид: раскладка клавиш — забота вида, а не правила хода.
    expect(listMove('Enter', 0, 3)).toBeNull();
    expect(listMove('Escape', 0, 3)).toBeNull();
    expect(listMove('ArrowLeft', 0, 3)).toBeNull();
  });

  it('буква и цифра — переход по началу', () => {
    expect(listMove('с', 0, 3)).toEqual({ kind: 'type', letter: 'с' });
    expect(listMove('2', 0, 3)).toEqual({ kind: 'type', letter: '2' });
  });
});

describe('переход по первой букве', () => {
  const labels = ['Сохранить все', 'Сохранить как', 'Свойства', 'Открыть'];

  it('находит первое совпадение после текущей строки', () => {
    expect(typeaheadIndex(labels, 'о', 0)).toBe(3);
  });

  it('повторное нажатие листает одноимённые', () => {
    // Иначе «с-с-с» замирает на первой строке, а вторую не достать.
    expect(typeaheadIndex(labels, 'с', 0)).toBe(1);
    expect(typeaheadIndex(labels, 'с', 1)).toBe(2);
  });

  it('с конца списка ищет с начала', () => {
    // Без этого переход «застревал» бы в хвосте списка.
    expect(typeaheadIndex(labels, 'с', 2)).toBe(0);
  });

  it('ничего не нашлось — тишина, а не прыжок', () => {
    expect(typeaheadIndex(labels, 'я', 0)).toBeNull();
    expect(typeaheadIndex([], 'а', 0)).toBeNull();
    expect(typeaheadIndex(labels, '   ', 0)).toBeNull();
  });
});

describe('имена строк для activedescendant', () => {
  it('разные списки — разные строки', () => {
    expect(optionId('a', 0)).toBe('a-option-0');
    expect(optionId('b', 0)).toBe('b-option-0');
  });
});
