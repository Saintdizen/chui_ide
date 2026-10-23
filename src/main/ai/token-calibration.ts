import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Файл поправок оценки токенов — рядом с `settings.json`.
 *
 * Поправка калибрует грубую оценку «символы ÷ N» по настоящим числам провайдера.
 * Она принадлежит `TokenCalibration` (shared/context-fit.ts), но живёт отдельно
 * от `AiService`: тот ведёт прогон, а это просто файл на диске. Заодно
 * проверяется без настроек и без окна.
 */

/** Где лежит файл: рядом с настройками, по одному на установку. */
export function calibrationPath(settingsFile: string): string {
  return path.join(path.dirname(settingsFile), 'token-calibration.json');
}

/** Прочитать сохранённые поправки; нет файла или мусор — начинаем с чистого листа. */
export function readCalibration(settingsFile: string): unknown {
  try {
    return JSON.parse(readFileSync(calibrationPath(settingsFile), 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Сохранить поправки. Поправка — необязательное удобство: сбой записи не
 * должен ломать чат, поэтому ошибки глушим. Пишем через временный файл и
 * переименование — иначе оборванная запись оставит полуфайл, который потом
 * не прочитается.
 */
export function saveCalibration(settingsFile: string, snapshot: unknown): void {
  try {
    const file = calibrationPath(settingsFile);
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, JSON.stringify(snapshot), 'utf8');
    renameSync(temporary, file);
  } catch {
    // Калибровка — удобство, а не данные: терять из-за неё ответ нельзя.
  }
}
