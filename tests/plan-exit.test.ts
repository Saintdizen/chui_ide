import { describe, expect, it } from 'vitest';
import {
  MAX_PLAN_CHARS,
  MAX_PLAN_NOTE_CHARS,
  clipPlanNote,
  clipPlanText,
  parsePlanExitArgs,
  planExitResult,
  sanitizePlanExitDecision,
} from '../src/shared/plan-exit';

describe('exit_plan_mode: разбор аргументов', () => {
  it('берёт план словами из аргументов', () => {
    const plan = parsePlanExitArgs(JSON.stringify({ plan: '  Прочитать indexer\nПоправить отпечаток ' }));
    expect(plan).toBe('Прочитать indexer\nПоправить отпечаток');
  });

  it('без аргументов и на битом JSON не падает — плана словами нет', () => {
    expect(parsePlanExitArgs('')).toBe('');
    expect(parsePlanExitArgs('не json')).toBe('');
    expect(parsePlanExitArgs('[]')).toBe('');
    expect(parsePlanExitArgs(JSON.stringify({}))).toBe('');
    expect(parsePlanExitArgs(JSON.stringify({ plan: 42 }))).toBe('');
  });

  it('длинный план режется по границе слова, а не по символу', () => {
    const long = `${'шаг '.repeat(MAX_PLAN_CHARS)}конец`;
    const text = clipPlanText(long);
    expect(text.length).toBeLessThanOrEqual(MAX_PLAN_CHARS + 1);
    expect(text.endsWith('…')).toBe(true);
    expect(text).not.toContain('ша\uFFFD');
  });
});

describe('exit_plan_mode: решение человека', () => {
  it('«да» — только явное approved: true', () => {
    expect(sanitizePlanExitDecision({ approved: true, note: 'лишнее' })).toEqual({ approved: true, note: 'лишнее' });
    expect(sanitizePlanExitDecision({ approved: 'да' })).toEqual({ approved: false, note: '' });
    expect(sanitizePlanExitDecision(null)).toEqual({ approved: false, note: '' });
    expect(sanitizePlanExitDecision({ approved: false, note: '  ' })).toEqual({ approved: false, note: '' });
  });

  it('замечание обрезается по потолку', () => {
    const note = 'а'.repeat(MAX_PLAN_NOTE_CHARS + 50);
    const text = clipPlanNote(note);
    expect(text.length).toBeLessThanOrEqual(MAX_PLAN_NOTE_CHARS + 1);
    expect(text.endsWith('…')).toBe(true);
  });

  it('утверждение говорит модели, что режим уже сменился', () => {
    const text = planExitResult({ approved: true, note: '' });
    expect(text).toContain('План утверждён');
    expect(text).toContain('Агент');
  });

  it('отказ без замечания не выдумывает причину', () => {
    const text = planExitResult({ approved: false, note: '' });
    expect(text).toContain('не утверждён');
    expect(text).toContain('exit_plan_mode');
    expect(text).not.toContain('Замечание человека');
  });

  it('отказ с замечанием уносит его модели дословно', () => {
    const text = planExitResult({ approved: false, note: 'сначала тесты, потом правка' });
    expect(text).toContain('Замечание человека: сначала тесты, потом правка');
  });
});
