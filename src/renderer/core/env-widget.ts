import type { ProjectTools } from './project-tools';
import { envShortLabel, envVisible } from './python-view';

/**
 * Виджет окружения в статусбаре — общий для языков.
 *
 * Один и тот же уголок полосы рассказывает про окружение проекта, но на разных
 * языках это разное: у Python — интерпретатор (и попап с окружениями), у Node —
 * версия из PATH и менеджер пакетов. Раньше виджет был только Python-овым, и в
 * Node-проекте в нём висел чужой интерпретатор. Решение принимаем по виду проекта.
 */

/** Короткая подпись Node-окружения: версия из PATH, а без неё — менеджер пакетов. */
export function nodeEnvShortLabel(tools: ProjectTools): string | null {
  if (!tools.root) return null;
  if (tools.nodeVersion) return `node ${tools.nodeVersion}`;
  return tools.hasPackageJson ? tools.packageManager : null;
}

/**
 * Подпись виджета окружения. У Node-проекта — Node, у Python и неизвестного —
 * интерпретатор, если он осмыслен (см. envVisible). null — виджет скрыт.
 */
export function envWidgetLabel(kindId: string | null, tools: ProjectTools, configured: string): string | null {
  if (!tools.root) return null;
  if (kindId === 'node') return nodeEnvShortLabel(tools);
  if (envVisible(kindId, tools, configured)) return envShortLabel(tools);
  return null;
}
