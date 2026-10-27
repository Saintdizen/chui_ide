import path from 'node:path';
import type { LspDiagnostic, LspProjectDiagnosticsPayload } from '../../shared/api';

/** Сколько файлов копим, прежде чем отправить пачку: событие на каждый файл — дорого. */
const BATCH_FILES = 64;

/** Дольше этого не ждём: пометки идут вживую, пачка нужна и ради одного файла. */
const BATCH_MS = 200;

export interface ProjectDiagnosticsDeps {
  /** Включить приём пометок у языковых серверов; возвращает выключатель. */
  collect(sink: (path: string, diagnostics: LspDiagnostic[]) => void): () => void;
  /** Брать ли файл в счёт: чужие (пакеты, зависимости) в счёт не идут. */
  include?(path: string): boolean;
  /** Отправить пачку в окно. */
  publish(payload: LspProjectDiagnosticsPayload): void;
  /** Отложенный вызов: в тестах подменяется, чтобы не ждать настоящих таймеров. */
  defer?(fn: () => void): void;
}

export interface ProjectDiagnostics {
  /** Начинается новый обход: прежние пометки к нему не относятся. */
  begin(): void;
  /** Включить приём на время обхода; возвращает выключатель. */
  start(): () => void;
}

/**
 * Пометки всего проекта — числом в строке состояния.
 *
 * Сервер говорит о файле только пока тот открыт, а открывать каждый файл ради
 * счёта — дорого. Дорогу уже протаптывает обход символов (`SymbolIndexer`): он
 * открывает серверу каждый файл и забирает объявления. Здесь мы включаем приём
 * пометок на время этого обхода и отдаём их в окно пачками.
 *
 * Заход считается новым после `begin()`: окно по этому признаку снимает со счёта
 * пометки прошлого обхода, иначе ошибка удалённого файла жила бы вечно.
 */
export function createProjectDiagnostics(deps: ProjectDiagnosticsDeps): ProjectDiagnostics {
  let pending: Array<{ path: string; diagnostics: LspDiagnostic[] }> = [];
  let scheduled = false;
  const defer =
    deps.defer ??
    ((fn: () => void) => {
      setTimeout(fn, BATCH_MS).unref?.();
    });

  const flush = (): void => {
    scheduled = false;
    if (pending.length === 0) return;
    const files = pending;
    pending = [];
    deps.publish({ start: false, files });
  };

  return {
    begin(): void {
      // Снятие прошлых пометок уходит сразу, а не с первой пачкой: если проект
      // чист, пачек не будет вовсе, и старые ошибки жили бы вечно.
      pending = [];
      deps.publish({ start: true, files: [] });
    },
    start(): () => void {
      return deps.collect((path, diagnostics) => {
        if (deps.include && !deps.include(path)) return;
        // Пустой список обход не запоминает: сервер шлёт его и на закрытие файла,
        // и запомнив его мы стёрли бы только что полученные ошибки.
        if (diagnostics.length === 0) return;
        pending.push({ path, diagnostics });
        if (pending.length >= BATCH_FILES) {
          flush();
          return;
        }
        if (scheduled) return;
        scheduled = true;
        defer(flush);
      });
    },
  };
}

/**
 * Каталоги, чьи ошибки — не наши: зависимости, сборка, кэши.
 * Считать их в строке состояния значило бы показывать чужой долг.
 */
const FOREIGN_DIRS = new Set([
  'node_modules',
  '.git',
  '.venv',
  'venv',
  'site-packages',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '__pycache__',
]);

/** Файл принадлежит проекту: лежит внутри корня и не в чужом каталоге. */
export function isProjectSource(root: string | null, file: string): boolean {
  if (!root) return false;
  const relative = path.relative(root, file);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  return !relative.split(path.sep).some((part) => FOREIGN_DIRS.has(part));
}
