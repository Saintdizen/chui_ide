import { describe, expect, it } from 'vitest';
import { checkName } from '../src/shared/name-check';

/**
 * Имя для файла или папки, введённое руками.
 *
 * Проверка отвечает ПРИЧИНОЙ: «нельзя» без объяснения заставляет человека
 * перебирать варианты наугад. И проверка нужна до вызова main — иначе молча
 * ничего не происходит.
 */
describe('пустое и пробелы', () => {
  it('пустое имя — отказ', () => {
    expect(checkName('').ok).toBe(false);
    expect(checkName('   ').reason).toContain('пустым');
  });

  it('пробел в конце — отказ: его не видно, а путь уже другой', () => {
    expect(checkName('name ').ok).toBe(false);
    expect(checkName(' name').ok).toBe(false);
  });
});

describe('точки', () => {
  it('`.` и `..` — это сами папки', () => {
    expect(checkName('.').ok).toBe(false);
    expect(checkName('..').ok).toBe(false);
  });

  it('скрытый файл начинается с точки и это законно', () => {
    expect(checkName('.env').ok).toBe(true);
  });
});

describe('недопустимые символы', () => {
  it('слэш — вложенность, а не имя', () => {
    expect(checkName('a/b').reason).toContain('/');
  });

  it('двоеточие ломает Windows, но не Linux', () => {
    expect(checkName('a:b').ok).toBe(true);
    expect(checkName('a:b', { windows: true }).reason).toContain('Windows');
  });

  it('зарезервированное имя DOS — только на Windows', () => {
    expect(checkName('con.txt').ok).toBe(true);
    expect(checkName('con.txt', { windows: true }).reason).toContain('зарезервированное');
  });

  it('точка в конце имени — только на Windows', () => {
    expect(checkName('a.').ok).toBe(true);
    expect(checkName('a.', { windows: true }).ok).toBe(false);
  });

  it('управляющий символ — отказ везде', () => {
    expect(checkName('a\u0007b').ok).toBe(false);
  });
});

describe('занятость', () => {
  const siblings = ['Button.tsx', 'util'];

  it('занятое имя — отказ', () => {
    expect(checkName('util', { siblings }).reason).toContain('уже есть');
  });

  it('регистр не помогает: `button.tsx` рядом с `Button.tsx` — тот же файл', () => {
    expect(checkName('button.tsx', { siblings }).ok).toBe(false);
  });

  it('своё же имя при переименовании — не занятость', () => {
    expect(checkName('Button.tsx', { siblings, original: 'Button.tsx' }).ok).toBe(true);
  });

  it('смена регистра своего имени — можно', () => {
    expect(checkName('button.tsx', { siblings, original: 'Button.tsx' }).ok).toBe(true);
  });

  it('без списка соседей занятость не выдумывается', () => {
    expect(checkName('util').ok).toBe(true);
  });
});
