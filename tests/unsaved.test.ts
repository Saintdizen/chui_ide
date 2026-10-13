import { describe, expect, it } from 'vitest';
import { revertPrompt, unsavedClosePrompt } from '../src/shared/unsaved';

/**
 * Текст диалога при закрытии окна с несохранёнными файлами. Проверяем три вещи:
 * число в сообщении, перечисление имён и свёртку длинного списка. Отдельно —
 * разделитель: на Windows пути приходят с обратными слэшами, и имя должно
 * остаться именем, а не путём целиком.
 */
describe('unsavedClosePrompt', () => {
  it('один файл — про файл в единственном числе', () => {
    const prompt = unsavedClosePrompt(['/proj/src/app.ts']);
    expect(prompt.message).toBe('Файл изменён и не сохранён');
    expect(prompt.detail).toBe('app.ts. Сохранить перед закрытием?');
  });

  it('несколько файлов — с числом и перечислением', () => {
    const prompt = unsavedClosePrompt(['/proj/a.py', '/proj/b.py']);
    expect(prompt.message).toBe('Несохранённых файлов: 2');
    expect(prompt.detail).toBe('a.py, b.py. Сохранить перед закрытием?');
  });

  it('путь Windows: берём последний сегмент, а не весь путь', () => {
    const prompt = unsavedClosePrompt(['C:\\proj\\src\\index.ts']);
    expect(prompt.detail).toBe('index.ts. Сохранить перед закрытием?');
  });

  it('длинный список сворачивается в «и ещё N»', () => {
    const files = Array.from({ length: 10 }, (_, index) => `/proj/f${index}.ts`);
    const prompt = unsavedClosePrompt(files);
    expect(prompt.message).toBe('Несохранённых файлов: 10');
    expect(prompt.detail).toBe(
      'f0.ts, f1.ts, f2.ts, f3.ts, f4.ts, f5.ts, f6.ts, f7.ts и ещё 2. Сохранить перед закрытием?',
    );
  });

  it('пустой список — не падаем', () => {
    const prompt = unsavedClosePrompt([]);
    expect(prompt.message).toBe('Нет несохранённых файлов');
    expect(prompt.detail).toBe('');
  });
});

/**
 * Текст подтверждения перед возвратом к версии на диске. Правки в буфере при
 * этом теряются, поэтому в подробностях обязано быть сказано, что именно
 * потеряется — иначе подтверждение читается как «просто перечитать».
 */
describe('revertPrompt', () => {
  it('один файл — спрашиваем об его правках', () => {
    const prompt = revertPrompt(['/proj/src/app.ts']);
    expect(prompt.message).toBe('Отменить правки в буфере?');
    expect(prompt.detail).toBe('app.ts. Файлы будут перечитаны с диска, правки в них потеряются.');
  });

  it('несколько файлов — с числом', () => {
    const prompt = revertPrompt(['/proj/a.py', '/proj/b.py']);
    expect(prompt.message).toBe('Отменить правки в буфере: файлов 2');
    expect(prompt.detail).toBe('a.py, b.py. Файлы будут перечитаны с диска, правки в них потеряются.');
  });

  it('длинный список сворачивается, как в диалоге закрытия', () => {
    const files = Array.from({ length: 10 }, (_, index) => `/proj/f${index}.ts`);
    const prompt = revertPrompt(files);
    expect(prompt.message).toBe('Отменить правки в буфере: файлов 10');
    expect(prompt.detail).toBe(
      'f0.ts, f1.ts, f2.ts, f3.ts, f4.ts, f5.ts, f6.ts, f7.ts и ещё 2. Файлы будут перечитаны с диска, правки в них потеряются.',
    );
  });

  it('пустой список — не падаем', () => {
    const prompt = revertPrompt([]);
    expect(prompt.message).toBe('Правок в буфере нет');
    expect(prompt.detail).toBe('');
  });
});

/**
 * Текст подтверждения перед возвратом к версии на диске. Правки в буфере при
 * этом теряются, поэтому в подробностях обязано быть сказано, что именно
 * потеряется — иначе подтверждение читается как «просто перечитать».
 */
describe('revertPrompt', () => {
  it('один файл — спрашиваем об его правках', () => {
    const prompt = revertPrompt(['/proj/src/app.ts']);
    expect(prompt.message).toBe('Отменить правки в буфере?');
    expect(prompt.detail).toBe('app.ts. Файлы будут перечитаны с диска, правки в них потеряются.');
  });

  it('несколько файлов — с числом', () => {
    const prompt = revertPrompt(['/proj/a.py', '/proj/b.py']);
    expect(prompt.message).toBe('Отменить правки в буфере: файлов 2');
    expect(prompt.detail).toBe('a.py, b.py. Файлы будут перечитаны с диска, правки в них потеряются.');
  });

  it('длинный список сворачивается, как в диалоге закрытия', () => {
    const files = Array.from({ length: 10 }, (_, index) => `/proj/f${index}.ts`);
    const prompt = revertPrompt(files);
    expect(prompt.message).toBe('Отменить правки в буфере: файлов 10');
    expect(prompt.detail).toBe(
      'f0.ts, f1.ts, f2.ts, f3.ts, f4.ts, f5.ts, f6.ts, f7.ts и ещё 2. Файлы будут перечитаны с диска, правки в них потеряются.',
    );
  });

  it('пустой список — не падаем', () => {
    const prompt = revertPrompt([]);
    expect(prompt.message).toBe('Правок в буфере нет');
    expect(prompt.detail).toBe('');
  });
});
