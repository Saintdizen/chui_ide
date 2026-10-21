import { describe, expect, it } from 'vitest';
import { budgetMessage, budgetVerdict } from '../src/shared/chat-budget';

/**
 * Бюджет беседы в деньгах.
 *
 * Главное правило: потолок, которого человек не ставил (0), не должен ничего
 * менять. Второе: при исчерпании беседа не обрывается, если есть куда
 * деградировать, — обрывать работу посреди правки хуже, чем доработать дешевле.
 */
describe('budgetVerdict', () => {
  it('без потолка — всегда ok, сколько бы ни потратили', () => {
    expect(budgetVerdict({ limitUsd: 0, spentUsd: 0 }, { canDegrade: true })).toEqual({ action: 'ok' });
    expect(budgetVerdict({ limitUsd: 0, spentUsd: 999 }, { canDegrade: true })).toEqual({ action: 'ok' });
  });

  it('отрицательный потолок — тоже «выключен», а не «всё сразу кончилось»', () => {
    expect(budgetVerdict({ limitUsd: -5, spentUsd: 999 }, { canDegrade: false })).toEqual({ action: 'ok' });
  });

  it('ниже потолка — ok', () => {
    expect(budgetVerdict({ limitUsd: 1, spentUsd: 0.99 }, { canDegrade: true })).toEqual({ action: 'ok' });
  });

  it('на потолке и выше — деградация, если дешёвая модель есть', () => {
    expect(budgetVerdict({ limitUsd: 1, spentUsd: 1 }, { canDegrade: true })).toEqual({
      action: 'degrade',
      spentUsd: 1,
      limitUsd: 1,
    });
    expect(budgetVerdict({ limitUsd: 1, spentUsd: 3 }, { canDegrade: true }).action).toBe('degrade');
  });

  it('деградировать некуда — честная остановка, а не тихий перерасход', () => {
    expect(budgetVerdict({ limitUsd: 1, spentUsd: 2 }, { canDegrade: false })).toEqual({
      action: 'stop',
      spentUsd: 2,
      limitUsd: 1,
    });
  });

  it('мусор в расходе не превращается в «бюджет кончился»', () => {
    expect(budgetVerdict({ limitUsd: 1, spentUsd: -10 }, { canDegrade: true })).toEqual({ action: 'ok' });
  });
});

describe('budgetMessage', () => {
  it('при деградации говорим, что дальше дешевле', () => {
    const text = budgetMessage({ action: 'degrade', spentUsd: 1.234, limitUsd: 1 }, true);
    expect(text).toContain('1.23');
    expect(text).toContain('дешёвой моделью');
  });

  it('при остановке говорим, что делать человеку', () => {
    const text = budgetMessage({ action: 'stop', spentUsd: 2, limitUsd: 1 }, false);
    expect(text).toContain('2.00');
    expect(text).toContain('поднимите потолок');
  });
});
