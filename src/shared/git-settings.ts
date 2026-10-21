import type { GitSettings } from './api';
import { normalizePullMode } from './git-pull';

/**
 * Настройки git: значения по умолчанию и приведение прочитанного файла к
 * безопасному виду. Живёт в `shared`, а не в main: разбор чистый (ни Electron,
 * ни ФС), поэтому его видно тестам, и обе стороны — main и renderer — читают
 * один и тот же набор полей, а не каждый свой.
 */
export const DEFAULT_GIT_SETTINGS: GitSettings = {
  // Режим pull не подсказываем: git ведёт себя как настроен у человека.
  // Навязывать слияние или перебазирование без спроса было бы навязчиво.
  pullMode: 'default',
  // Перед коммитом сохраняем несохранённые файлы: коммит читает рабочее дерево,
  // а не экран, и правки из буфера иначе остались бы в стороне от коммита.
  saveBeforeCommit: true,
  // Переключение ветки тоже идёт по диску: непoxранённый буфер оно не видит.
  // Но checkout меняет файлы под ногами, поэтому по умолчанию СОХРАНЯЕМ сами:
  // висящий вопрос «а куда делся мой текст?» здесь дороже одного тихого сохранения.
  saveBeforeCheckout: true,
};

/**
 * Файл настроек могли править руками: держим только известные значения.
 * Режим pull приводим к списку известных, а флаг «сохранять перед коммитом»
 * выключаем ТОЛЬКО явным `false` — отсутствие поля значит «включено», как и
 * умолчание (иначе пропавшее поле тихо меняло бы поведение).
 */
export function sanitizeGitSettings(raw: unknown): GitSettings {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    pullMode: normalizePullMode(value.pullMode),
    saveBeforeCommit: value.saveBeforeCommit !== false,
    saveBeforeCheckout: value.saveBeforeCheckout !== false,
  };
}
