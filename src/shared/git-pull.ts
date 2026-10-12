/**
 * Режим `git pull`: как вливать пришедшие коммиты в текущую ветку.
 *
 * Разные команды и проекты живут по-разному: где-то принято всегда слияние, где-то —
 * перебазирование, а кто-то настраивает это в самом git и не хочет, чтобы IDE
 * вмешивалась. Поэтому есть режим «как в git», а явные варианты едут флагами
 * `--no-rebase` / `--rebase` / `--ff-only`.
 */

/** Как вливать изменения при `pull`. */
export type PullMode =
  /** Не подсказывать флаги: git ведёт себя так, как настроен (`pull.rebase` и т. п.). */
  | 'default'
  /** Всегда слияние (`--no-rebase`). */
  | 'merge'
  /** Перебазировать локальные коммиты на пришедшие (`--rebase`). */
  | 'rebase'
  /** Только перемотка вперёд: если ветки разошлись — отказ, правки не тронуты (`--ff-only`). */
  | 'ff-only';

/** Все режимы в порядке показа в списке. */
export const PULL_MODES: readonly PullMode[] = ['default', 'merge', 'rebase', 'ff-only'];

/** Привести значение из настроек к известному режиму; неизвестное — `default`. */
export function normalizePullMode(value: unknown): PullMode {
  return typeof value === 'string' && (PULL_MODES as readonly string[]).includes(value)
    ? (value as PullMode)
    : 'default';
}

/** Подпись режима для интерфейса. */
export function pullModeLabel(mode: PullMode): string {
  switch (mode) {
    case 'default':
      return 'Как настроено в git';
    case 'merge':
      return 'Слияние (merge)';
    case 'rebase':
      return 'Перебазирование (rebase)';
    case 'ff-only':
      return 'Только перемотка (ff-only)';
  }
}

/** Флаги к `git pull` для режима. Пустой список — режим не подсказывает ничего. */
export function pullModeArgs(mode: PullMode): string[] {
  switch (mode) {
    case 'merge':
      return ['--no-rebase'];
    case 'rebase':
      return ['--rebase'];
    case 'ff-only':
      return ['--ff-only'];
    case 'default':
      return [];
  }
}
