import { describe, expect, it } from 'vitest';
import { downgradeSeverity } from '../src/shared/lsp-severity';

/**
 * Степень пометки с поправкой на правило: где сервер написал `error`, но это замечание
 * о стиле (`reportIncompatibleVariableOverride` у pyright), показываем предупреждение.
 * Настоящие ошибки остаются красными.
 */
describe('downgradeSeverity', () => {
  it('переопределение имени в наследнике — предупреждение, а не ошибка', () => {
    expect(downgradeSeverity('error', 'reportIncompatibleVariableOverride')).toBe('warning');
    expect(downgradeSeverity('error', 'reportIncompatibleMethodOverride')).toBe('warning');
  });

  it('настоящие ошибки остаются ошибками', () => {
    expect(downgradeSeverity('error', 'reportGeneralTypeIssues')).toBe('error');
    expect(downgradeSeverity('error', 'reportArgumentType')).toBe('error');
    expect(downgradeSeverity('error', 'reportAttributeAccessIssue')).toBe('error');
    expect(downgradeSeverity('error', 'reportInvalidTypeForm')).toBe('error');
  });

  it('без кода правила степень не трогаем', () => {
    expect(downgradeSeverity('error', undefined)).toBe('error');
    expect(downgradeSeverity('error', '')).toBe('error');
  });

  it('предупреждение и подсказка остаются как были', () => {
    expect(downgradeSeverity('warning', 'reportIncompatibleVariableOverride')).toBe('warning');
    expect(downgradeSeverity('info', 'reportIncompatibleVariableOverride')).toBe('info');
  });

  it('код с уточнением после `#` тоже узнаётся', () => {
    expect(downgradeSeverity('error', 'reportUnusedImport#x')).toBe('warning');
  });
});
