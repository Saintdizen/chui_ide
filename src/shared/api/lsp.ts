import type { ThemeFile } from '../theme-file';

/* ── LSP ───────────────────────────────────────────────────────────────── */

/** Один языковой сервер: язык, команда запуска и включён ли он. */
export interface LspServerConfig {
  /** Идентификатор языка (как в shared/languages.ts): python, typescript, … */
  language: string;
  command: string;
  args: string[];
  enabled: boolean;
  /**
   * Подпись для интерфейса. Нужна серверам из поставки: у них `command` — путь к
   * самому Electron (`ELECTRON_RUN_AS_NODE`), и показывать его человеку нечего.
   */
  label?: string;
  /** Дополнительные переменные окружения процесса сервера (например, режим Node). */
  env?: Record<string, string>;
  /**
   * Довод к `initialize`. Нужен серверам из поставки: TypeScript Language Server
   * требует назвать путь к своему `tsserver.js` (см. `shared/lsp-bundled.ts`).
   */
  initializationOptions?: Record<string, unknown>;
}

export interface LspSettings {
  /** Общий выключатель: без него серверы не запускаются. */
  enabled: boolean;
  /**
   * Журнал обмена с серверами: все сообщения обоих направлений пишутся в файл
   * (путь говорит main). Нужен для отладки: без него «сервер молчит» — догадка.
   */
  trace: boolean;
  servers: LspServerConfig[];
}

/** Пометка от языкового сервера, уже привязанная к файлу. */
export interface LspDiagnostic {
  severity: 'error' | 'warning' | 'info';
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  message: string;
  source?: string;
  /**
   * Код правила у сервера (`reportIncompatibleVariableOverride` у pyright, `E501` у ruff).
   * Нужен, чтобы отличать настоящую ошибку от замечания о стиле: и то и другое сервер
   * шлёт как `error`, а по коду видно, чего это правило стоит (см. `shared/lsp-severity.ts`).
   */
  code?: string;
}

/** Полезная нагрузка события `PushTopic.LspDiagnostics`. */
export interface LspDiagnosticsPayload {
  path: string;
  diagnostics: LspDiagnostic[];
}

/** Полезная нагрузка события `PushTopic.ThemeChanged`: сменилась тема из файла. */
export interface ThemeChangedPayload {
  /** Активная тема из файла — или `null`, если работает встроенная палитра. */
  customTheme?: ThemeFile | null;
}
