import { lineChanges, type GitLineChange } from '../../shared/git-line-changes';

export interface ChangeGutterDeps {
  /** Содержимое версии в HEAD. `null` — файл вне репозитория: полосок быть не должно. */
  headText(path: string): Promise<string | null>;
  /** Текущий текст файла в редакторе (с несохранёнными правками). */
  currentText(path: string): string | null;
  /** Файлы, открытые в редакторе прямо сейчас. */
  paths(): string[];
  /** Нарисовать полоски файла; пустой список — снять их. */
  show(path: string, changes: readonly GitLineChange[]): void;
}

export interface ChangeGutterController {
  readonly enabled: boolean;
  /** Включить или выключить показ; возвращает новое состояние. */
  toggle(): boolean;
  /** Репозиторий или история изменились (git-операция): перечитать и HEAD, и правки. */
  refresh(): void;
  /** Содержимое или состав открытых файлов изменились: пересчитать, но HEAD не спрашивать. */
  refreshContent(): void;
}

/** Задержка перед расчётом: во время набора и ходьбы курсором считать на каждый шаг незачем. */
const DELAY_MS = 300;

/** Отпечаток набора правок: одинаковый — значит перерисовывать нечего. */
function signature(changes: readonly GitLineChange[]): string {
  return changes.map((change) => `${change.line}:${change.kind}`).join(',');
}

/**
 * Полоски изменений в жёлобе редактора: добавленные, изменённые и удалённые строки
 * файла относительно HEAD.
 *
 * Сравнивается текущий текст редактора с версией в HEAD — так в жёлобе видно и
 * несохранённые правки, а номера строк совпадают с тем, что на экране. Текст HEAD
 * кэшируется по файлу и сбрасывается только на git-операции: во время набора он
 * не меняется, а спрашивать его на каждую правку было бы лишним процессом.
 *
 * Показ включён по умолчанию: полоски — часть базовой работы с git, и без них
 * непонятно, что уже изменено. Выключаются командой (см. `git.toggleChangeGutter`).
 */
export function createChangeGutterController(deps: ChangeGutterDeps): ChangeGutterController {
  let enabled = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Номер последнего расчёта: ответ с меньшим номером — устаревший. */
  let requestId = 0;
  /** Что уже нарисовано: путь → отпечаток набора правок. */
  const drawn = new Map<string, string>();
  /** Текст HEAD по файлам; сбрасывается на git-операции. */
  const headCache = new Map<string, string | null>();

  const headFor = async (path: string): Promise<string | null> => {
    if (headCache.has(path)) return headCache.get(path) ?? null;
    const value = await deps.headText(path).catch(() => null);
    headCache.set(path, value);
    return value;
  };

  const changesFor = async (path: string): Promise<GitLineChange[]> => {
    const current = deps.currentText(path);
    if (current === null) return [];
    const original = await headFor(path);
    if (original === null) return [];
    return lineChanges(original, current);
  };

  const compute = async (): Promise<void> => {
    const id = (requestId += 1);
    const paths = deps.paths();
    const results = await Promise.all(paths.map(async (path) => ({ path, changes: await changesFor(path) })));
    // Пока считали, пришёл более свежий запрос — этот результат уже неактуален.
    if (id !== requestId) return;

    const next = new Set<string>();
    for (const { path, changes } of results) {
      next.add(path);
      const mark = signature(changes);
      if (drawn.get(path) === mark) continue;
      drawn.set(path, mark);
      deps.show(path, changes);
    }
    // Файл закрыли или он перестал быть видимым — снимаем с него полоски.
    for (const path of [...drawn.keys()]) {
      if (next.has(path)) continue;
      drawn.delete(path);
      deps.show(path, []);
    }
  };

  const schedule = (): void => {
    if (!enabled) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void compute();
    }, DELAY_MS);
  };

  const stop = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    // Поднимаем номер: расчёт, уже начатый, свой результат не покажет.
    requestId += 1;
  };

  return {
    get enabled() {
      return enabled;
    },
    toggle() {
      enabled = !enabled;
      if (!enabled) {
        stop();
        for (const path of drawn.keys()) deps.show(path, []);
        drawn.clear();
      } else {
        schedule();
      }
      return enabled;
    },
    refresh() {
      headCache.clear();
      schedule();
    },
    refreshContent() {
      schedule();
    },
  };
}
