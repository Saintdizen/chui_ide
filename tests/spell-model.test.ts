import { describe, expect, it, vi } from 'vitest';
import { SpellCheck } from '../src/renderer/core/spellcheck';

describe('SpellCheck', () => {
  it('без словаря не готов', () => {
    const spell = new SpellCheck();
    expect(spell.ready).toBe(false);
    expect(spell.knows('hello')).toBe(false);
  });

  it('знает слова системного словаря и их формы', () => {
    const spell = new SpellCheck();
    spell.setDictionary(['dog']);
    expect(spell.ready).toBe(true);
    expect(spell.knows('dogs')).toBe(true);
    expect(spell.knows('xyzzy')).toBe(false);
  });

  it('слово человека снимает отметку', () => {
    const spell = new SpellCheck();
    spell.setDictionary(['dog']);
    expect(spell.knows('фубара')).toBe(false);
    spell.addUserWord('фубара');
    expect(spell.knows('фубара')).toBe(true);
  });

  it('пропущенное слово знает в любом регистре', () => {
    const spell = new SpellCheck();
    spell.setDictionary(['dog']);
    spell.ignore('Чужое');
    expect(spell.knows('чужое')).toBe(true);
    expect(spell.knows('ЧУЖОЕ')).toBe(true);
  });

  it('событие летит на каждое пополнение', () => {
    const spell = new SpellCheck();
    const listener = vi.fn();
    spell.onDidChange(listener);
    spell.setDictionary(['dog']);
    spell.setUserWords(['word']);
    spell.addUserWord('ещё');
    spell.ignore('то');
    expect(listener).toHaveBeenCalledTimes(4);
  });
});
