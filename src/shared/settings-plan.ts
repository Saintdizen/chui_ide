import type { Settings } from './api';

/**
 * Что перестроить после применения настроек, а что не трогать.
 *
 * Зачем отдельно: решения принимает `applySettings` в `app.ts`, запертый в
 * замыкании над редактором, словарём, автосохранением и языковыми серверами.
 * Проверить их можно только руками — а цена ошибки не косметическая: лишний
 * `importChecker.refresh()` обходит все открытые файлы, лишний `refreshLsp()`
 * поднимает серверы заново.
 *
 * Отдельно про сравнение блока `run`: раньше здесь стояло `previous.run !==
 * next.run` — сравнение ПО ССЫЛКЕ. Настройки собираются разбором JSON, то есть
 * на каждый вызов получается новый объект, и условие было верным почти всегда:
 * смена темы перепроверяла импорты во всех файлах. Здесь сравнение по значению,
 * и оно же делает модуль проверяемым без окна.
 */

/** Шаги, которые надо выполнить после подмены настроек. */
export interface SettingsPlan {
  /** Пересобрать модель словаря человека: он мог измениться. */
  spellWords: boolean;
  /** Перезапустить таймер автосохранения: сменили режим или паузу. */
  autoSave: boolean;
  /** Разбудить языковые серверы: их включили тумблером. */
  warmLsp: boolean;
  /** Перепроверить импорты в открытых файлах: сменилось окружение запуска. */
  imports: boolean;
}

/** Одинаково ли содержимое двух значений — без опоры на идентичность объектов. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * План на переходе «было → стало».
 *
 * Разбудить серверы — только на включении: выключение ничего не поднимает,
 * подъёмы прекращает сам main (`startLanguage` смотрит на `lsp.enabled`).
 */
export function settingsPlan(previous: Settings, next: Settings): SettingsPlan {
  return {
    spellWords: !same(previous.editor.spellWords, next.editor.spellWords),
    autoSave:
      previous.editor.autoSave !== next.editor.autoSave ||
      previous.editor.autoSaveDelayMs !== next.editor.autoSaveDelayMs,
    warmLsp: previous.lsp.enabled !== true && next.lsp.enabled === true,
    imports: !same(previous.run, next.run),
  };
}
