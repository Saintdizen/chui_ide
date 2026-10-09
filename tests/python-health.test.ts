import { describe, expect, it } from 'vitest';
import { describeEnvIssues, type EnvFacts } from '../src/shared/python-health';

const HEALTHY: EnvFacts = {
  label: '.venv',
  cfgRead: true,
  basePath: '/usr/bin/python3.12',
  baseExists: true,
  hasPip: true,
};

describe('describeEnvIssues', () => {
  it('здоровое окружение — пустой список', () => {
    expect(describeEnvIssues(HEALTHY)).toEqual([]);
  });

  it('нечитаемый pyvenv.cfg — ошибка, дальше не смотрим', () => {
    const issues = describeEnvIssues({ ...HEALTHY, cfgRead: false, hasPip: false });
    expect(issues.map((issue) => issue.kind)).toEqual(['cfg-missing']);
    expect(issues[0].severity).toBe('error');
  });

  it('пропавший базовый интерпретатор — ошибка с путём в тексте', () => {
    const issues = describeEnvIssues({ ...HEALTHY, baseExists: false });
    expect(issues.map((issue) => issue.kind)).toEqual(['base-missing']);
    expect(issues[0].severity).toBe('error');
    expect(issues[0].message).toContain('/usr/bin/python3.12');
  });

  it('неизвестное состояние базового питона не считается ошибкой', () => {
    expect(describeEnvIssues({ ...HEALTHY, baseExists: null })).toEqual([]);
  });

  it('нет pip — предупреждение, а не ошибка', () => {
    const issues = describeEnvIssues({ ...HEALTHY, hasPip: false });
    expect(issues.map((issue) => issue.kind)).toEqual(['no-pip']);
    expect(issues[0].severity).toBe('warning');
  });

  it('поломки копятся: база пропала и pip нет', () => {
    const issues = describeEnvIssues({ ...HEALTHY, baseExists: false, hasPip: false });
    expect(issues.map((issue) => issue.kind)).toEqual(['base-missing', 'no-pip']);
  });

  it('в сообщении есть имя окружения', () => {
    const issues = describeEnvIssues({ ...HEALTHY, label: 'backend/.venv', hasPip: false });
    expect(issues[0].message).toContain('backend/.venv');
  });
});
