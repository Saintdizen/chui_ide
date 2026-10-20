import { describe, expect, it } from 'vitest';
import type { ApplyEditsHostResult } from '../src/shared/api';
import { mergePatchResult } from '../src/renderer/ui/chat-patches';

/**
 * Свод ответа о правках по якорю.
 *
 * Проверка сторожит один конкретный промах: свод собирал ответ заново и терял
 * оговорку «правка осталась в буфере». Снаружи это выглядело так: `edit` по якорю
 * отвечает «применено», а файл на диске не изменился — и агент, перечитав файл,
 * видел старый текст, хотя правка в буфере редактора уже была.
 */

const report = { path: '/proj/a.ts', applied: 1, version: 2 };

describe('mergePatchResult', () => {
  it('оговорка «осталось в буфере» доходит до ответа', () => {
    const outcome: ApplyEditsHostResult = {
      rejected: false,
      result: { reports: [report], failed: [] },
      unwritten: ['/proj/a.ts'],
    };

    const merged = mergePatchResult(outcome, []);

    expect(merged.rejected).toBe(false);
    expect(merged.result?.reports).toEqual([report]);
    expect(merged.unwritten).toEqual(['/proj/a.ts']);
  });

  it('всё записано — поля про буфер нет', () => {
    const outcome: ApplyEditsHostResult = { rejected: false, result: { reports: [report], failed: [] } };

    const merged = mergePatchResult(outcome, []);

    expect(merged.unwritten).toBeUndefined();
    expect('unwritten' in merged).toBe(false);
  });

  it('несведённые якоря идут к ошибкам применения', () => {
    const outcome: ApplyEditsHostResult = {
      rejected: false,
      result: { reports: [report], failed: [{ path: '/proj/b.ts', message: 'файл только для чтения' }] },
    };

    const merged = mergePatchResult(outcome, [{ path: '/proj/c.ts', message: 'текст в файле не найден' }]);

    expect(merged.result?.failed).toEqual([
      { path: '/proj/b.ts', message: 'файл только для чтения' },
      { path: '/proj/c.ts', message: 'текст в файле не найден' },
    ]);
  });

  it('ответ без результата не роняет свод', () => {
    const merged = mergePatchResult({ rejected: false }, [{ path: '/proj/c.ts', message: 'не найден' }]);

    expect(merged.result).toEqual({ reports: [], failed: [{ path: '/proj/c.ts', message: 'не найден' }] });
  });
});
