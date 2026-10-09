/**
 * Здоровье виртуального окружения: что с ним не так и чем это грозит.
 *
 * Здесь только решение по фактам, без файловой системы: «окружение сломано» —
 * это правило, а не I/O, и ошибиться в нём дороже всего. Факты собирает main
 * (он читает `pyvenv.cfg` и смотрит каталоги), а правила живут здесь и потому
 * видны в тестах без Electron.
 *
 * Зачем вообще: самые частые поломки окружения молчаливы. Окружение, созданное
 * питоном, которого потом не стало (обновили систему, перенесли проект), выглядит
 * целым, но любая команда падает. Лучше сказать об этом заранее.
 */

/** Что именно не так с окружением. */
export type EnvIssueKind =
  /** `pyvenv.cfg` не читается: окружение повреждено или это не окружение. */
  | 'cfg-missing'
  /** Базовый интерпретатор из `pyvenv.cfg` не найден на диске. */
  | 'base-missing'
  /** В окружении нет pip: пакеты поставить не получится. */
  | 'no-pip';

export interface EnvIssue {
  kind: EnvIssueKind;
  /** `error` — работать нельзя, `warning` — можно, но с оговоркой. */
  severity: 'error' | 'warning';
  /** Готовое объяснение человеку: что случилось и что делать. */
  message: string;
}

/** Проблемы одного окружения: имя в интерфейсе и список найденного. */
export interface EnvironmentHealth {
  label: string;
  issues: EnvIssue[];
}

/**
 * Факты об окружении, собранные main. `null` там, где признак не проверяли:
 * неизвестное не должно превращаться в ошибку.
 */
export interface EnvFacts {
  /** Как окружение называется в интерфейсе (`.venv`, `backend/.venv`). */
  label: string;
  /** `pyvenv.cfg` прочитан и разобран. */
  cfgRead: boolean;
  /** Путь к базовому интерпретатору из `pyvenv.cfg`; null — в файле его нет. */
  basePath: string | null;
  /** Базовый интерпретатор есть на диске; null — проверить не удалось. */
  baseExists: boolean | null;
  /** В окружении есть pip. */
  hasPip: boolean;
}

/** Проблемы окружения по фактам. Пустой список — окружение в порядке. */
export function describeEnvIssues(facts: EnvFacts): EnvIssue[] {
  const issues: EnvIssue[] = [];

  // Без конфига это не рабочее окружение: питон в нём есть, а связки с базовым нет.
  if (!facts.cfgRead) {
    return [
      {
        kind: 'cfg-missing',
        severity: 'error',
        message: `${facts.label}: pyvenv.cfg не читается — окружение повреждено, пересоздайте его`,
      },
    ];
  }

  // Самая коварная поломка: окружение цело, но создано исчезнувшим питоном.
  if (facts.baseExists === false) {
    const where = facts.basePath ? ` (${facts.basePath})` : '';
    issues.push({
      kind: 'base-missing',
      severity: 'error',
      message: `${facts.label}: базовый интерпретатор не найден${where} — окружение создано питоном, которого больше нет`,
    });
  }

  if (!facts.hasPip) {
    issues.push({
      kind: 'no-pip',
      severity: 'warning',
      message: `${facts.label}: в окружении нет pip — установить пакеты не получится`,
    });
  }

  return issues;
}

/** Есть ли среди проблем хоть одна ошибка (а не предупреждение). */
export function hasBlockingIssue(issues: readonly EnvIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'error');
}
