import { describe, expect, it } from 'vitest';
import { expectedAt, filterByExpectation, fitsExpectation } from '../src/renderer/editor/complete/expectation';

/**
 * Умное дополнение: чего ждёт место под курсором.
 *
 * Полноценное сравнение по типу требует модели типов (её знает сервер), поэтому здесь
 * проверяется то, что выводится из текста: значение после `=`, тип после `:` и `->`,
 * и «не решаем» в неясных случаях. Ошибаться правилу можно только в сторону «спрятать
 * лишнее» — это и проверяем.
 */

const item = (detail: string, label = detail) => ({ label, detail });

describe('expectedAt', () => {
  it('присваивание и аргументы — ждём значение', () => {
    expect(expectedAt('value = ')).toBe('value');
    expect(expectedAt('value ==')).toBe('value');
    expect(expectedAt('return ')).toBe('value');
    expect(expectedAt('call(')).toBe('value');
    expect(expectedAt('call(a, ')).toBe('value');
    expect(expectedAt('await ')).toBe('value');
  });

  it('аннотация и тип возврата — ждём тип', () => {
    expect(expectedAt('value: ')).toBe('type');
    expect(expectedAt('def run(self) -> ')).toBe('type');
  });

  it('сравнение не считается присваиванием', () => {
    // `==`, `!=`, `<=`, `>=` — это проверка, а не «справа значение».
    expect(expectedAt('a ==')).toBe('value');
    expect(expectedAt('a !=')).toBe('value');
    expect(expectedAt('a <=')).toBe('value');
  });

  it('неясное место — не решаем', () => {
    expect(expectedAt('')).toBe('any');
    expect(expectedAt('value')).toBe('any');
    expect(expectedAt('self.')).toBe('any');
  });

  it('двойное двоеточие — срез, а не аннотация', () => {
    expect(expectedAt('items[1::')).toBe('value');
  });
});

describe('fitsExpectation', () => {
  it('в позиции значения тип бесполезен', () => {
    expect(fitsExpectation('value', 'класс')).toBe(false);
    expect(fitsExpectation('value', 'интерфейс')).toBe(false);
    expect(fitsExpectation('value', 'функция')).toBe(true);
    expect(fitsExpectation('value', 'переменная')).toBe(true);
  });

  it('после двоеточия переменная не заменяет тип', () => {
    expect(fitsExpectation('type', 'переменная')).toBe(false);
    expect(fitsExpectation('type', 'класс')).toBe(true);
  });

  it('незнакомое не прячем: спрятать нужное хуже, чем показать лишнее', () => {
    expect(fitsExpectation('value', 'ключевое слово')).toBe(true);
    expect(fitsExpectation('type', 'ключевое слово')).toBe(true);
  });
});

describe('filterByExpectation', () => {
  it('порядок сервера сохраняется', () => {
    const items = [item('функция', 'b'), item('класс', 'a'), item('переменная', 'c')];
    expect(filterByExpectation(items, 'value').map((one) => one.label)).toEqual(['b', 'c']);
  });

  it('в неясном месте фильтр ничего не трогает', () => {
    const items = [item('класс'), item('переменная')];
    expect(filterByExpectation(items, 'any')).toEqual(items);
  });
});
