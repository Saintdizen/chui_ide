import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MACRO_TIMES,
  checkMacroTimes,
  macroPlayCheck,
  macroPlayedNotice,
  macroRecordedNotice,
} from '../src/renderer/core/macro-run';

describe('macroRecordedNotice', () => {
  it('пустой макрос — честно про пустоту', () => {
    expect(macroRecordedNotice(0)).toBe('Макрос пуст: ни одного действия');
  });

  it('записанный — число действий', () => {
    expect(macroRecordedNotice(3)).toBe('Макрос записан: действий 3');
  });
});

describe('macroPlayCheck', () => {
  it('нет макроса — отказ', () => {
    expect(macroPlayCheck(0, true)).toEqual({ kind: 'refused', message: 'Макрос не записан' });
  });

  it('нет файла — отказ, и он говорит, что делать', () => {
    const check = macroPlayCheck(2, false);
    expect(check.kind).toBe('refused');
  });

  it('пустой макрос и нет файла: сначала «не записан» — это первая причина', () => {
    expect(macroPlayCheck(0, false)).toEqual({ kind: 'refused', message: 'Макрос не записан' });
  });

  it('всё на месте — играть', () => {
    expect(macroPlayCheck(2, true)).toEqual({ kind: 'ok', times: 1 });
  });
});

describe('checkMacroTimes', () => {
  it('обычное число', () => {
    expect(checkMacroTimes('7')).toEqual({ kind: 'ok', times: 7 });
  });

  it('пробелы по краям не мешают', () => {
    expect(checkMacroTimes('  3 ')).toEqual({ kind: 'ok', times: 3 });
  });

  it.each(['0', '-1', '1.5', 'много', '', '1001'])('«%s» — отказ', (raw) => {
    expect(checkMacroTimes(raw).kind).toBe('refused');
  });

  it('1000 — ещё можно: потолок включительный', () => {
    expect(checkMacroTimes('1000')).toEqual({ kind: 'ok', times: 1000 });
  });

  it('предлагаемое по умолчанию само проходит проверку', () => {
    expect(checkMacroTimes(String(DEFAULT_MACRO_TIMES)).kind).toBe('ok');
  });
});

describe('macroPlayedNotice', () => {
  it('один раз — без «1 раз»: это шум', () => {
    expect(macroPlayedNotice(1, 5)).toBe('Макрос выполнен: шагов 5');
  });

  it('несколько — число повторов и всего шагов', () => {
    expect(macroPlayedNotice(3, 15)).toBe('Макрос выполнен 3 раз (шагов: 15)');
  });
});
