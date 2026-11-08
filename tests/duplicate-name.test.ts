import { describe, expect, it } from 'vitest';
import { duplicateName, duplicatePlan } from '../src/renderer/core/duplicate-name';

/**
 * «Дублировать» не должно превращать `a.ts` в `a.ts copy` и не должно плодить
 * `a copy.txt copy`. Мелочи, но их видит человек сразу после команды.
 */

const never = (): boolean => false;

describe('duplicateName', () => {
  it('вставляет «copy» перед расширением', () => {
    expect(duplicateName('index.ts', false, never)).toBe('index copy.ts');
  });

  it('второй копии даёт номер', () => {
    const taken = new Set(['index copy.ts']);
    expect(duplicateName('index.ts', false, (c) => taken.has(c))).toBe('index copy 2.ts');
  });

  it('у папки точка — часть имени', () => {
    expect(duplicateName('my.config', true, never)).toBe('my.config copy');
  });

  it('у файла без расширения суффикс в конце', () => {
    expect(duplicateName('Makefile', false, never)).toBe('Makefile copy');
  });

  it('скрытый файл — не расширение', () => {
    expect(duplicateName('.gitignore', false, never)).toBe('.gitignore copy');
  });

  it('имя из нескольких точек режется по последней', () => {
    expect(duplicateName('a.test.ts', false, never)).toBe('a.test copy.ts');
  });
});

describe('duplicatePlan', () => {
  it('кладёт копию рядом с исходным', () => {
    const plan = duplicatePlan('/root/src/a.ts', false, never);
    expect(plan.target).toBe('/root/src/a copy.ts');
  });
});
