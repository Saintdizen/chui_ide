import type { PythonEnvironment } from '../../shared/python-env';
import type { ProjectTools } from './project-tools';

/**
 * Что показывать про Python-окружение в статусбаре и его попапе.
 *
 * Здесь только решения, без DOM: «какой интерпретатор выбран, откуда он взялся
 * и стоит ли вообще показывать виджет». Так их видно в тестах — ошибиться в
 * порядке приоритетов (настройка → окружение → системный) дороже всего.
 */

/** Откуда взят интерпретатор. Порядок важен: настройка сильнее окружения. */
export type EnvSource = 'setting' | 'project' | 'system';

/**
 * Источник интерпретатора. Тот же порядок, что у запуска (см. ProjectToolsModel):
 * явная настройка `run.pythonPath` перебивает окружение проекта, а системный —
 * последний вариант, когда ничего другого нет.
 */
export function envSource(configured: string, tools: ProjectTools): EnvSource {
  const value = configured.trim();
  if (value) return value.includes('/') ? 'setting' : 'system';
  if (tools.pythonFromProject) return 'project';
  return 'system';
}

/** Подпись источника для попапа — человеку, а не коду. */
export function envSourceLabel(source: EnvSource): string {
  if (source === 'setting') return 'Из настроек (run.pythonPath)';
  if (source === 'project') return 'Окружение проекта';
  return 'Системный интерпретатор';
}

/**
 * Короткая подпись для статусбара: `.venv` или `python3`.
 * `pythonLabel` бывает длинным (`.venv · ./.venv/bin/python`) — берём часть до «·»:
 * в полосе места мало, а подробности есть в попапе.
 */
export function envShortLabel(tools: ProjectTools): string {
  const [head] = tools.pythonLabel.split('·');
  const value = (head ?? tools.pythonLabel).trim() || tools.pythonLabel;
  // Полный путь в полосе не помещается: у окружения показываем его каталог — `.venv`.
  const parts = value.split(/[/\\]/).filter(Boolean);
  const last = parts[parts.length - 1] ?? '';
  if (parts.length >= 2 && /^python(\.exe)?$/i.test(last)) {
    const dir = parts[parts.length - 2] ?? '';
    const parent = parts[parts.length - 3];
    if (/^(bin|Scripts)$/i.test(dir) && parent) return parent;
    return dir || value;
  }
  return value;
}

/**
 * Показывать ли виджет окружения. У Python-проекта — всегда; у остальных только
 * тогда, когда интерпретатор уже выбран (настройкой или найденным окружением).
 * Иначе у Node-проекта в полосе висело бы «python3 (системный)» без причины.
 */
export function envVisible(projectKind: string | null, tools: ProjectTools, configured: string): boolean {
  if (configured.trim()) return true;
  if (tools.pythonFromProject) return true;
  return projectKind === 'python';
}

/** Окружения для показа: главное — первым, порядок остальных сохраняем. */
export function envList(environments: readonly PythonEnvironment[]): PythonEnvironment[] {
  return [...environments].sort((a, b) => Number(b.primary) - Number(a.primary));
}
