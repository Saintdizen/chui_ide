import { describe, expect, it } from 'vitest';
import { SpellCheck } from '../src/renderer/core/spellcheck';

/**
 * П .38: у словаря три слоя — система, человек, проект.
 * Проверяем не внутренности, а что видит проверка орфографии.
 */
describe('SpellCheck: словарь проекта поверх остальных', () => {
  it('слово проекта не считается ошибкой', () => {
    const spell = new SpellCheck();
    spell.setDictionary(['мир']);
    expect(spell.knows('chui')).toBe(false);
    spell.setProjectWords(['chui']);
    expect(spell.knows('chui')).toBe(true);
  });

  it('слово человека и слово проекта — разные слои', () => {
    const spell = new SpellCheck();
    spell.setUserWords(['одно']);
    spell.setProjectWords(['другое']);
    expect(spell.knows('одно')).toBe(true);
    expect(spell.knows('другое')).toBe(true);
  });

  it('смена проектного списка снимает прежние слова', () => {
    const spell = new SpellCheck();
    spell.setProjectWords(['термин']);
    expect(spell.knows('термин')).toBe(true);
    // Открыли другой проект — термин больше не известен.
    spell.setProjectWords(['другой']);
    expect(spell.knows('термин')).toBe(false);
    expect(spell.knows('другой')).toBe(true);
  });

  it('подсказки из проекта идут раньше системных', () => {
    const spell = new SpellCheck();
    // Оба слова — в одном шаге от опечатки: расстояние у них равное, и порядок
    // в списке решает только слой, а не близость. Иначе тест проверял бы порог
    // отсева, а не то, что проектный словарь идёт первым.
    spell.setDictionary(['конфигс']);
    spell.setProjectWords(['конфиг']);
    const suggestions = spell.suggest('конфигг');
    expect(suggestions).toContain('конфиг');
    expect(suggestions).toContain('конфигс');
    expect(suggestions.indexOf('конфиг')).toBeLessThan(suggestions.indexOf('конфигс'));
  });

  it('пустой проектный список не ломает готовность словаря', () => {
    const spell = new SpellCheck();
    expect(spell.ready).toBe(false);
    spell.setProjectWords([]);
    expect(spell.ready).toBe(false);
    spell.setProjectWords(['слово']);
    expect(spell.ready).toBe(true);
  });

  it('регистр не важен: слово проекта ловится в любом виде', () => {
    const spell = new SpellCheck();
    spell.setProjectWords(['ChuiIDE']);
    expect(spell.knows('chuiide')).toBe(true);
    expect(spell.knows('CHUIIDE')).toBe(true);
  });
});
