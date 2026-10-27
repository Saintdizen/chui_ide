import { describe, expect, it } from 'vitest';
import { problemsWidget } from '../src/renderer/ui/problems-widget';

/**
 * Виджет проблем: когда показывать число, когда слово, а когда молчать.
 *
 * Главное правило — молчание значит «проверили, чисто». Поэтому ноль без
 * проверки (нет линтера, отказ, холодный старт) обязан стать словами.
 */

describe('problemsWidget: слова вместо врущего ноля', () => {
  it('проверка не состоялась — «не проверено» вместо «0 ошибок»', () => {
    const view = problemsWidget({ errors: 0, warnings: 0, unchecked: 'Линтера в проекте нет' });

    expect(view.hidden).toBe(false);
    expect(view.text).toBe('не проверено');
    expect(view.tone).toBe('unchecked');
    expect(view.title).toContain('Линтера в проекте нет');
  });

  it('не уложились во время и ничего не нашли — тоже «не проверено»', () => {
    const view = problemsWidget({ errors: 0, warnings: 0, partial: true });

    expect(view.text).toBe('не проверено');
    expect(view.title).toContain('не уложилась во время');
  });

  it('проверили и чисто — виджет молчит', () => {
    const view = problemsWidget({ errors: 0, warnings: 0 });

    expect(view).toMatchObject({ hidden: true, tone: 'plain', text: '' });
  });

  it('идёт проход — слово и признак, числа ещё не про него', () => {
    const view = problemsWidget({ errors: 3, warnings: 1, checking: true });

    expect(view.text).toBe('проверяю…');
    expect(view.tone).toBe('checking');
    expect(view.hidden).toBe(false);
  });
});

describe('problemsWidget: числа и склонения', () => {
  it('ошибки и предупреждения вместе, в правильном падеже', () => {
    expect(problemsWidget({ errors: 1, warnings: 2 }).text).toBe('1 ошибка, 2 предупреждения');
    expect(problemsWidget({ errors: 21, warnings: 11 }).text).toBe('21 ошибка, 11 предупреждений');
    expect(problemsWidget({ errors: 5, warnings: 0 }).text).toBe('5 ошибок');
    expect(problemsWidget({ errors: 0, warnings: 4 }).text).toBe('4 предупреждения');
    expect(problemsWidget({ errors: 12, warnings: 0 }).text).toBe('12 ошибок');
  });

  it('цвет различает ошибку и предупреждение', () => {
    expect(problemsWidget({ errors: 2, warnings: 0 }).tone).toBe('errors');
    expect(problemsWidget({ errors: 0, warnings: 2 }).tone).toBe('warnings');
  });

  it('найденное при неполной проверке показываем числом, причину — в подсказке', () => {
    const view = problemsWidget({ errors: 2, warnings: 0, partial: true });

    expect(view.text).toBe('2 ошибки');
    expect(view.tone).toBe('errors');
    expect(view.title).toContain('не уложилась во время');
  });
});
