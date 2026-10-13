/**
 * Состояние языковых серверов: что запущено, откуда взято и что не поднялось.
 *
 * Отдельным модулем, а не полем внутри `LspServerConfig`, потому что это ответ
 * РАНТАЙМА, а не настройка: сервер поднимается лениво при открытии файла, и узнать,
 * что он за сервер и докуда дошёл, можно только у запущенного процесса. Показываем
 * это человеку (чип в статусбаре и попап) — иначе «почему тут нет подсказок» ищут
 * наугад, а причина обычно видна: не найден, не поднялся или взят не оттуда.
 *
 * Модуль чистый: типы и подписи, ни сети, ни диска. Поэтому его видно в тестах.
 */

/** Откуда взят запущенный сервер. */
export type LspServerOrigin = 'settings' | 'python' | 'bundled' | 'path';

/** Запущенный языковой сервер: что за сервер и откуда он взят. */
export interface LspServerStatus {
  /** Язык, который сервер обслуживает (`python`, `typescript`, …). */
  language: string;
  /** Подпись для человека: у серверов поставки своя, иначе — имя команды. */
  label: string;
  origin: LspServerOrigin;
}

/** Язык, сервер которого поднять не удалось, и почему — это и есть ответ «почему нет». */
export interface LspFailureStatus {
  language: string;
  /** Короткая причина: «сервер не найден», «не ответил на initialize». */
  reason: string;
}

/** Полное состояние языковых серверов — ответ `lsp.status`. */
export interface LspStatus {
  /** Языки, для которых сервер запущен. Прежняя форма ответа, её читают и пробы. */
  running: string[];
  /** Что за серверы запущены и откуда. */
  servers: LspServerStatus[];
  /** Что не поднялось: язык и причина. Пусто — всё поднялось (или ещё не просили). */
  failed: LspFailureStatus[];
}

/** Пометка, что серверов нет вовсе (или ещё не спрашивали). */
export const NO_LSP_STATUS: LspStatus = { running: [], servers: [], failed: [] };

/** Откуда взят сервер — короткая подпись для интерфейса. */
export function lspOriginLabel(origin: LspServerOrigin): string {
  if (origin === 'bundled') return 'поставка IDE';
  if (origin === 'python') return 'окружение проекта';
  if (origin === 'settings') return 'свой путь';
  return 'PATH';
}

/** Чем показать сервер языка в статусбаре: подпись, источник и причина отказа. */
export interface LspChip {
  language: string;
  label: string;
  /** Источник сервера; `null` — сервер не поднялся, источника нет. */
  origin: LspServerOrigin | null;
  /** Причина отказа; `null` — сервер работает. */
  failed: string | null;
}

/**
 * Чем показать сервер языка в статусбаре. `null` — языка нет или про него ничего не
 * известно: молчать честнее, чем висеть пустым чипом. Упавший сервер показываем —
 * это и есть ответ на вопрос «почему нет подсказок».
 */
export function lspChipFor(language: string | null, status: LspStatus): LspChip | null {
  if (!language) return null;
  const server = status.servers.find((item) => item.language === language);
  if (server) return { language, label: server.label, origin: server.origin, failed: null };
  const failure = status.failed.find((item) => item.language === language);
  if (failure) return { language, label: language, origin: null, failed: failure.reason };
  return null;
}
