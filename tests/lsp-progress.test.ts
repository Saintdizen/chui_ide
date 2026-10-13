import { describe, expect, it } from 'vitest';
import { parseProgress, progressLabel } from '../src/shared/lsp-progress';

/**
 * Разбор `$/progress`. Уведомление одно на два случая — «идёт работа» и «частичный
 * результат», и различаются они по форме `value`. Проверяем и то, что чужое уведомление
 * (токен не наш, форма непонятна) тихо пропускается: сервер вправе слать лишнее.
 */

describe('parseProgress', () => {
  it('begin: заголовок и токен', () => {
    const progress = parseProgress({ token: 't1', value: { kind: 'begin', title: 'Индексирую' } });

    expect(progress).toEqual({ kind: 'work', token: 't1', phase: 'begin', title: 'Индексирую' });
  });

  it('report: уточнение и проценты', () => {
    const progress = parseProgress({ token: 7, value: { kind: 'report', message: 'файл 3', percentage: 30 } });

    expect(progress).toMatchObject({ kind: 'work', token: 7, phase: 'report', message: 'файл 3', percentage: 30 });
  });

  it('end: занятие закончилось', () => {
    expect(parseProgress({ token: 'x', value: { kind: 'end' } })).toEqual({
      kind: 'work',
      token: 'x',
      phase: 'end',
    });
  });

  it('частичный результат — value с items и без kind', () => {
    const progress = parseProgress({ token: 'p1', value: { items: [{ a: 1 }, { a: 2 }] } });

    expect(progress).toEqual({ kind: 'partial', token: 'p1', items: [{ a: 1 }, { a: 2 }] });
  });

  it('составной прогресс: массив состояний берёт первое понятное', () => {
    const progress = parseProgress({
      token: 't',
      value: [
        { kind: 'begin', title: 'A' },
        { kind: 'begin', title: 'B' },
      ],
    });

    expect(progress).toMatchObject({ kind: 'work', title: 'A' });
  });

  it('чужое и битое — null, а не падение', () => {
    expect(parseProgress(null)).toBeNull();
    expect(parseProgress({})).toBeNull();
    expect(parseProgress({ token: 't' })).toBeNull();
    expect(parseProgress({ token: {}, value: { kind: 'begin' } })).toBeNull();
    expect(parseProgress({ token: 't', value: { kind: 'что-то' } })).toBeNull();
    expect(parseProgress({ token: 't', value: 42 })).toBeNull();
  });
});

describe('progressLabel', () => {
  it('уточнение важнее заголовка, а без них — общая подпись', () => {
    expect(progressLabel({ kind: 'work', token: 't', phase: 'report', message: 'шаг 2', title: 'Индексация' })).toBe(
      'шаг 2',
    );
    expect(progressLabel({ kind: 'work', token: 't', phase: 'begin', title: 'Индексация' })).toBe('Индексация');
    expect(progressLabel({ kind: 'work', token: 't', phase: 'report' })).toBe('Идёт работа');
  });
});
