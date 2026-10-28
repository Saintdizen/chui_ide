import type { LineProfile } from '../line-profile';
import type { PythonEnvironment, VenvLocation } from '../python-env';

/* ── Python: окружения и создание venv ─────────────────────────────────── */

/** Уровень установки пакетов при создании окружения. */
export type VenvInstallPreset = 'empty' | 'pytest' | 'full';

export interface CreateVenvOptions {
  /** Имя каталога окружения. По умолчанию `.venv`. */
  name?: string;
  /** Где создать: в проекте (по умолчанию), в `~/.venvs` или в своей папке. */
  location?: VenvLocation;
  /** Своя папка для `location: 'custom'`: абсолютный путь, `~` или путь от корня проекта. */
  path?: string;
  /** Базовый интерпретатор для создания окружения, если задан явно. */
  base?: string;
  /** Доустановить pytest, pylsp, ruff — одним из готовых профилей. */
  preset?: VenvInstallPreset;
  /** Поставить зависимости из requirements.txt, если он есть. */
  installRequirements?: boolean;
  /**
   * Чистое окружение: ни профиля, ни requirements — только питон и pip.
   * Сильнее остальных полей: `preset` и `installRequirements` при этом игнорируются.
   */
  clean?: boolean;
}

/** Событие прогресса создания окружения: шаг и вывод команд. */
export interface VenvProgressPayload {
  type: 'step' | 'output' | 'done' | 'error';
  message: string;
}

export interface CreateVenvResult {
  environment: PythonEnvironment;
  /** Что реально поставили: `requirements.txt` и/или имена пакетов. */
  installed: string[];
}

/** Что поставить в главное окружение проекта. */
export interface PythonInstallOptions {
  /** Явные пакеты: то, что человек выбрал, и то, что подсказали подчёркнутые импорты. */
  packages?: string[];
  /** Доустановить то, что просит `requirements.txt` (если файл есть). */
  requirements?: boolean;
}

/** Результат установки: что реально поставили. */
export interface PythonInstallResult {
  installed: string[];
}

/** Результат форматирования файла. */
export interface PythonFormatResult {
  /** Отформатированный текст; совпадает с исходным, если менять нечего. */
  text: string;
  /** Инструмент, который отформатировал; null — ни ruff, ни black не нашлись. */
  tool: string | null;
}

/**
 * Результат форматирования файла инструментом Node-проекта. Форма та же, что у
 * питоновского: renderer обрабатывает оба ответа одинаково.
 */
export type NodeFormatResult = PythonFormatResult;

/**
 * Профиль строк файла от своего профилировщика (`main/python/line-profile.ts`):
 * строки с временем и «жаром», плюс что программа напечатала и как завершилась.
 */
export interface PythonLineProfileResult {
  profile: LineProfile;
  /** Хвост вывода программы — показать его целиком незачем. */
  stdout: string;
  stderr: string;
  /** Прогон не состоялся: интерпретатор не запустился, истёк таймаут. */
  failed: boolean;
  /** Пояснение к неудаче для интерфейса; `null` — всё в порядке. */
  message: string | null;
}
