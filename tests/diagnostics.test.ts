import { describe, expect, it } from 'vitest';
import { describeError, formatDiagnostic, isQuietExit } from '../src/shared/diagnostics';

/**
 * Журнал сбоев. Читают его тогда, когда приложение уже не работает, поэтому
 * проверяем ровно то, от чего зависит читаемость: шапка со временем и
 * источником, подробности отдельными строками и текст для чего угодно —
 * бросить ведь можно не только Error.
 */
describe('formatDiagnostic', () => {
  it('шапка — время, источник и суть; подробности — с отступом', () => {
    const line = formatDiagnostic({
      source: 'main/uncaughtException',
      message: 'Error: бум',
      details: ['    at run (/app/main.js:1:2)', '    at start (/app/main.js:9:9)'],
      at: new Date('2026-02-03T04:05:06.789Z'),
    });

    expect(line).toBe(
      [
        '[2026-02-03T04:05:06.789Z] main/uncaughtException: Error: бум',
        '  at run (/app/main.js:1:2)',
        '  at start (/app/main.js:9:9)',
      ].join('\n'),
    );
  });

  it('пустые строки подробностей не попадают в журнал', () => {
    const line = formatDiagnostic({
      source: 'main/child-process-gone',
      message: 'процесс GPU завершился: crashed (код 1)',
      details: ['', '   ', 'служба: gpu'],
      at: new Date('2026-02-03T04:05:06.789Z'),
    });

    expect(line.split('\n')).toHaveLength(2);
    expect(line.endsWith('  служба: gpu')).toBe(true);
  });

  it('подробностей нет — остаётся одна строка', () => {
    const line = formatDiagnostic({
      source: 'main/unhandledRejection',
      message: 'undefined',
      at: new Date('2026-02-03T04:05:06.789Z'),
    });

    expect(line).toBe('[2026-02-03T04:05:06.789Z] main/unhandledRejection: undefined');
  });
});

describe('describeError', () => {
  it('Error — имя с сообщением, стек без повторяющейся первой строки', () => {
    const { message, details } = describeError(new TypeError('не число'));

    expect(message).toBe('TypeError: не число');
    expect(details.length).toBeGreaterThan(0);
    // Первая строка стека — то же «TypeError: не число», её в подробностях нет.
    expect(details[0].includes('TypeError: не число')).toBe(false);
    expect(details[0].trim().startsWith('at ')).toBe(true);
  });

  it('брошена строка — это и есть сообщение', () => {
    expect(describeError('сломалось')).toEqual({ message: 'сломалось', details: [] });
  });

  it('брошен объект — показываем JSON', () => {
    expect(describeError({ code: 42 })).toEqual({ message: '{"code":42}', details: [] });
  });

  it('undefined и null не превращаются в пустую строку', () => {
    expect(describeError(undefined).message).toBe('undefined');
    expect(describeError(null).message).toBe('null');
  });

  it('круговая ссылка не роняет сам обработчик сбоя', () => {
    const circle: Record<string, unknown> = {};
    circle.self = circle;

    expect(describeError(circle).message).toBe('[object Object]');
  });
});

describe('isQuietExit', () => {
  it('закрытие окна и снятие процесса — не повод для журнала', () => {
    expect(isQuietExit('clean-exit')).toBe(true);
    expect(isQuietExit('killed')).toBe(true);
  });

  it('падение и нехватка памяти — повод', () => {
    expect(isQuietExit('crashed')).toBe(false);
    expect(isQuietExit('oom')).toBe(false);
    expect(isQuietExit('launch-failed')).toBe(false);
  });
});
