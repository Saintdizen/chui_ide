import { languageFromPath } from '../../shared/languages';
import { joinPath } from '../../shared/paths';
import { pathToUri } from './document';
import type { DocumentStore } from './document-store';
import type { RpcClient } from './rpc';

/**
 * Файлы проекта — встроенному сервису TypeScript.
 *
 * Сервис проверяет импорты по СПИСКУ известных ему файлов: это зеркальные модели
 * открытых документов плюс то, что ему отдали отдельно. Открыты обычно один-два
 * файла, поэтому импорт соседа (`./rpc`) сервис не находил и подчёркивал строку
 * красным — «Cannot find module» на каждом относительном пути, хотя файл есть.
 * Отсюда и переход по Ctrl+Click не работал: цели для перехода он не видел.
 *
 * Поэтому отдаём ему файлы проекта: содержимое кладём отдельными «библиотеками»
 * (`addExtraLib`) с адресами в том же виде, что у моделей. Открытые документы
 * пропускаем — они и так видны как модели, и второй копии текста быть не должно.
 *
 * Набор ограничен: воркер держит эти файлы в памяти, и огромный репозиторий
 * (десятки тысяч файлов) его утопил бы. Служебные каталоги (`node_modules`, `dist`)
 * сюда не попадают вовсе — обход в main их пропускает.
 */

/** Потолок набора: больше — уже не подсказки, а тормоза. */
const MAX_FILES = 1500;
/** Файл крупнее не отдаём: на его разбор уйдёт больше, чем он стоит. */
const MAX_FILE_BYTES = 256 * 1024;
/** Сколько файлов читаем разом: по одному долго, все сразу — шквал запросов. */
const READ_CONCURRENCY = 8;
/** Пауза после события: правки идут серией, собирать набор на каждую незачем. */
const DELAY = 400;

/** Языки, которые разбирает сервис TypeScript. JavaScript он тоже понимает. */
const SCRIPT_LANGUAGES = new Set(['typescript', 'javascript']);

/** Набор файлов сервиса: нам от него нужна только одна операция. */
export interface ExtraLibTarget {
  addExtraLib(text: string, filePath: string): { dispose(): void };
}

export interface TsProjectDeps {
  rpc: RpcClient;
  documents: DocumentStore;
  root(): string | null;
  /** Наборы TypeScript и JavaScript: файл проекта может импортировать любой из них. */
  targets: readonly ExtraLibTarget[];
  /** Пауза перед сбором набора. В тестах — короткая, чтобы не ждать. */
  delay?: number;
}

export interface TsProjectFeed {
  /** Пересобрать набор — с небольшой задержкой, одним проходом на серию событий. */
  refresh(): void;
  dispose(): void;
}

/**
 * Файлы проекта, которые стоит отдать сервису: скрипты, кроме открытых.
 * Открытые — уже модели, порядок сохраняем: список приходит отсортированным.
 */
export function scriptFiles(paths: readonly string[], openPaths: ReadonlySet<string>, limit = MAX_FILES): string[] {
  const out: string[] = [];
  for (const path of paths) {
    if (out.length >= limit) break;
    if (openPaths.has(path)) continue;
    if (!SCRIPT_LANGUAGES.has(languageFromPath(path))) continue;
    out.push(path);
  }
  return out;
}

export function createTsProjectFeed(deps: TsProjectDeps): TsProjectFeed {
  /** Что уже отдано сервису: путь → добавленные наборы (по одному на TypeScript и JavaScript). */
  const added = new Map<string, Array<{ dispose(): void }>>();
  const delay = deps.delay ?? DELAY;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let queued = false;
  let disposed = false;

  const drop = (path: string): void => {
    const libs = added.get(path);
    if (!libs) return;
    for (const lib of libs) lib.dispose();
    added.delete(path);
  };

  const sync = async (): Promise<void> => {
    const root = deps.root();
    if (!root) {
      for (const path of [...added.keys()]) drop(path);
      return;
    }

    const relative = await deps.rpc.request('workspace.listFiles');
    if (disposed) return;

    const open = new Set(deps.documents.all().map((document) => document.path));
    const wanted = new Set(
      scriptFiles(
        relative.map((item) => joinPath(root, item)),
        open,
      ),
    );

    // Файл открыли или он исчез — его копия в наборе больше не нужна.
    for (const path of [...added.keys()]) {
      if (!wanted.has(path)) drop(path);
    }

    const missing = [...wanted].filter((path) => !added.has(path));
    if (missing.length === 0) return;

    const contents = await readFiles(deps.rpc, missing);
    if (disposed) return;

    for (const [path, text] of contents) {
      if (added.has(path)) continue;
      // Адрес — тот же, что у модели: сервис сопоставляет файлы по имени.
      const uri = pathToUri(path);
      added.set(
        path,
        deps.targets.map((target) => target.addExtraLib(text, uri)),
      );
    }
  };

  const run = async (): Promise<void> => {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      await sync();
    } catch {
      // Нет корня или списка файлов — набора просто не будет; повторим на следующем событии.
    } finally {
      running = false;
      if (queued && !disposed) {
        queued = false;
        void run();
      }
    }
  };

  return {
    refresh(): void {
      if (disposed) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void run();
      }, delay);
    },
    dispose(): void {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      for (const path of [...added.keys()]) drop(path);
    },
  };
}

/** Содержимое файлов: читаем пачками, пропуская слишком большие и уже удалённые. */
async function readFiles(rpc: RpcClient, paths: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= paths.length) return;

      const path = paths[index] as string;
      try {
        const file = await rpc.request('workspace.readFile', { path });
        if (file.text.length <= MAX_FILE_BYTES) out.set(path, file.text);
      } catch {
        // Файл исчез между обходом и чтением — не беда, просто не попадёт в набор.
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, paths.length) }, worker));
  return out;
}
