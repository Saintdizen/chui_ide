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
  /**
   * Дополнительные корни, которые сервер видит вместе с корнем проекта: папки
   * монорепы, откуда сервер языка должен разрешать импорты. Относительные пути
   * считаются от корня проекта; несуществующие пропускаются молча — настройка
   * живёт в файле дольше, чем папка.
   */
  extraFolders?: string[];
  /**
   * Приоритет выбора, когда для языка объявлено несколько серверов: больше —
   * раньше. При равном приоритете — порядок в списке: цепочка кандидатов
   * перебирается сверху вниз, пока один не поднимется.
   */
  priority?: number;
}

export interface LspSettings {
  /** Общий выключатель: без него серверы не запускаются. */
  enabled: boolean;
  /**
   * Журнал обмена с серверами: все сообщения обоих направлений пишутся в файл
   * (путь говорит main). Нужен для отладки: без него «сервер молчит» — догадка.
   */
  trace: boolean;
  /**
   * Сколько ждём ответа сервера на запрос, миллисекунды. Молча висящая подсказка —
   * то же, что поломка: без сторожа обещание не разрешится никогда (сервер завис
   * или не знает метода). Нет значения — 30 с (см. `DEFAULT_REQUEST_TIMEOUT_MS`).
   */
  requestTimeoutMs?: number;
  /**
   * Языки, в которых подсказки-вставки (inlay hints) выключены. Без записи — включены
   * всюду: подсказки рисуются только по видимой части, но в больших файлах тулза
   * мешает читать, и отключать их хочется точечно, а не везде.
   */
  inlayHintsOff?: string[];
  /** Языки, в которых код-линзы выключены (те же причины, что у inlay hints). */
  codeLensOff?: string[];
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

/**
 * Пометки обхода проекта: сервер публикует их только для открытых документов,
 * поэтому проект обходим сами (см. `SymbolIndexer`) и отдаём пачками.
 */
export interface LspProjectDiagnosticsPayload {
  /**
   * Начался новый заход: прежние пометки обхода к нынешнему состоянию проекта
   * уже не относятся, и их надо снять, иначе числа в строке состояния врут.
   */
  start: boolean;
  /** Пометки по файлам, накопленные с прошлой пачки. */
  files: Array<{ path: string; diagnostics: LspDiagnostic[] }>;
}

/** Полезная нагрузка события `PushTopic.ThemeChanged`: сменилась тема из файла. */
export interface ThemeChangedPayload {
  /** Активная тема из файла — или `null`, если работает встроенная палитра. */
  customTheme?: ThemeFile | null;
}
