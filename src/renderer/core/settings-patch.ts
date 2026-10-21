/**
 * Куда писать правку настроек.
 *
 * Настройки живут в двух местах, и это не случайность: IDE-секции (вид, AI, git…)
 * общие для всех проектов — они в userData; а editor/explorer/run/lsp принадлежат
 * конкретному проекту — они в его `.chui_ide`. Ошибка на этом месте тихая: правка
 * уедет не туда и потом «сама вернётся» при смене проекта.
 *
 * Разделение вынесено ради проверки: `PROJECT_SETTINGS_SECTIONS` — список, который
 * легко дополнить и легко забыть, а цена ошибки не видна глазом.
 */

import { PROJECT_SETTINGS_SECTIONS } from '../../shared/project-config';

export interface SplitPatch {
  /** Уходит в файл проекта (`.chui_ide`). */
  project: Record<string, unknown>;
  /** Уходит в userData (settings.json). */
  global: Record<string, unknown>;
}

/** Проектная ли секция: пишется в `.chui_ide`, а не в общие настройки. */
export function isProjectSection(key: string): boolean {
  return (PROJECT_SETTINGS_SECTIONS as readonly string[]).includes(key);
}

/**
 * Разложить правку по двум файлам. Секции сохраняют порядок и содержимое как есть:
 * правка половины секции — законный случай (например, только `editor.tabSize`).
 */
export function splitSettingsPatch(patch: Record<string, unknown>): SplitPatch {
  const project: Record<string, unknown> = {};
  const global: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(patch)) {
    if (isProjectSection(key)) project[key] = entry;
    else global[key] = entry;
  }
  return { project, global };
}

/** Есть ли что писать — чтобы не дёргать main пустым запросом. */
export function hasEntries(patch: Record<string, unknown>): boolean {
  return Object.keys(patch).length > 0;
}
