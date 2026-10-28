import { describe, expect, it } from 'vitest';
import { statusMeter } from '../src/renderer/ui/status-meter';

const NONE = { progress: null, symbols: null, check: null } as const;

const server = (percentage: number | null) => ({ label: 'Initializing JS/TS', percentage });
const symbols = { text: 'читаю проект: 20 из 300', title: 'карта', progress: { done: 20, total: 300 } };
const check = { done: 1, total: 3, running: ['code' as const] };

describe('одна полоса работы', () => {
  it('ничего не идёт — полосы нет', () => {
    expect(statusMeter(NONE).hidden).toBe(true);
  });

  // То, из-за чего этот модуль и появился: две полосы рядом — сервер и чтение проекта,
  // причём вторая стоит на «0 из 0», пока первая не отпустит.
  it('сервер и чтение проекта разом — показываем сервер', () => {
    const meter = statusMeter({ ...NONE, progress: server(null), symbols });
    expect(meter.label).toBe('Initializing JS/TS');
    expect(meter.busy).toBe(true);
  });

  it('сервер отпустил — полоса отдаётся чтению проекта', () => {
    const meter = statusMeter({ ...NONE, symbols });
    expect(meter.label).toBe('читаю проект: 20 из 300');
    expect(meter.fill).toBeCloseTo(20 / 300);
  });

  it('чтение проекта и проверка разом — показываем чтение', () => {
    const meter = statusMeter({ ...NONE, symbols, check });
    expect(meter.label).toBe('читаю проект: 20 из 300');
  });

  it('без сервера и карты остаётся проверка проекта', () => {
    const meter = statusMeter({ ...NONE, check });
    expect(meter.hidden).toBe(false);
    expect(meter.fill).toBeCloseTo(1 / 3);
  });

  it('процент сервера виден на полосе, и штрих не нужен', () => {
    const meter = statusMeter({ ...NONE, progress: server(40) });
    expect(meter.label).toBe('Initializing JS/TS 40%');
    expect(meter.fill).toBeCloseTo(0.4);
    expect(meter.busy).toBe(false);
  });
});
