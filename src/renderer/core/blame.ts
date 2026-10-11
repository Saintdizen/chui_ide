import type { BlameLine } from '../../shared/git-blame';
import { formatBlameAnnotation } from '../../shared/git-blame';

/** Подпись blame у строки: файл, строка и готовый текст аннотации. */
export interface BlameAnnotation {
  path: string;
  line: number;
  text: string;
}

export interface BlameControllerDeps {
  /** Происхождение одной строки. `null` — данных нет (файл не в git или пуст). */
  blameLine(path: string, line: number): Promise<BlameLine | null>;
  /** Происхождение всех строк файла — для режима «подписи у всего файла». */
  blameFile(path: string): Promise<BlameLine[]>;
  /** Показать подпись у строки; `null` — убрать. */
  show(annotation: BlameAnnotation | null): void;
  /** Нарисовать подписи у всех строк файла; пустой список — убрать у этого файла. */
  showAll(path: string, annotations: BlameAnnotation[]): void;
}

export interface BlameController {
  readonly enabled: boolean;
  /** Режим показа: выключено, у строки под курсором или у всего файла. */
  readonly mode: 'off' | 'line' | 'file';
  /** Включить или выключить показ у строки; возвращает новое состояние. */
  toggle(): boolean;
  /** Включить или выключить показ у всего файла; возвращает новое состояние. */
  toggleFile(): boolean;
  /** Курсор перешёл на другую позицию: обновить подпись (с задержкой). */
  update(path: string | null, line: number): void;
  /** Репозиторий или настройки сменились: перечитать подпись для текущей позиции. */
  refresh(): void;
}

/** Задержка перед запросом: пока человек ведёт курсором, спрашивать на каждую строку ни к чему. */
const REQUEST_DELAY_MS = 120;
/** Предел кэша: подпись одной строки — маленькая, но карта не должна расти без конца. */
const CACHE_LIMIT = 512;

/**
 * Подпись blame у строки под курсором.
 *
 * Показ включается по команде и по умолчанию выключен: `git blame` — это процесс
 * на каждый переход, и навязывать его всем было бы накладно. Запрос идёт с
 * задержкой (человек ведёт курсором — спрашивать на каждую строку незачем), а
 * результат кладётся в кэш по `файл:строка`: возврат на прежнюю строку не дёргает
 * git снова. Ответы устаревших запросов отбрасываются по счётчику — иначе подпись
 * от прошлой строки перекрыла бы свежую.
 */
export function createBlameController(deps: BlameControllerDeps): BlameController {
  let mode: 'off' | 'line' | 'file' = 'off';
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Номер последнего запроса: ответ с меньшим номером — устаревший. */
  let requestId = 0;
  /** Текущая позиция: с ней сверяется ответ, когда он придёт. */
  let position: { path: string; line: number } | null = null;
  /** Файл, у которого сейчас нарисованы подписи у всех строк. */
  let annotatedFile: string | null = null;
  const cache = new Map<string, string | null>();
  /** Подписи всего файла: кэш по пути, сбрасывается на смену репозитория и файла. */
  const fileCache = new Map<string, BlameAnnotation[]>();

  const key = (path: string, line: number): string => `${path}:${line}`;

  const remember = (entry: string, value: string | null): void => {
    if (cache.size >= CACHE_LIMIT) {
      // Первая запись — самая старая: карта вставляет по порядку использования лишь
      // приблизительно, но для кэша подписи этого достаточно.
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(entry, value);
  };

  const request = async (path: string, line: number): Promise<void> => {
    const id = (requestId += 1);
    const cacheKey = key(path, line);

    let text: string | null;
    if (cache.has(cacheKey)) {
      text = cache.get(cacheKey) ?? null;
    } else {
      const result = await deps.blameLine(path, line).catch(() => null);
      text = result ? formatBlameAnnotation(result) : null;
      remember(cacheKey, text);
    }

    // Курсор ушёл или пришёл более свежий ответ — эту подпись не показываем.
    if (id !== requestId) return;
    if (!position || position.path !== path || position.line !== line) return;
    deps.show(text ? { path, line, text } : null);
  };

  /** Подписи у всего файла: тянем один раз на файл, дальше берём из кэша. */
  const requestFile = async (path: string): Promise<void> => {
    const id = (requestId += 1);
    let annotations = fileCache.get(path);
    if (!annotations) {
      const lines = await deps.blameFile(path).catch(() => [] as BlameLine[]);
      annotations = lines.map((line) => ({
        path,
        line: line.line,
        text: formatBlameAnnotation(line),
      }));
      fileCache.set(path, annotations);
    }

    // Файл сменился или пришёл более свежий запрос — не рисуем.
    if (id !== requestId || mode !== 'file' || position?.path !== path) return;
    annotatedFile = path;
    // Подпись у строки под курсором в этом режиме не нужна — весь файл уже подписан.
    deps.show(null);
    deps.showAll(path, annotations);
  };

  const clearAll = (): void => {
    if (annotatedFile !== null) {
      deps.showAll(annotatedFile, []);
      annotatedFile = null;
    }
  };

  const schedule = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const current = position;
      if (mode === 'file') {
        if (current) void requestFile(current.path);
      } else if (mode === 'line' && current) {
        void request(current.path, current.line);
      }
    }, REQUEST_DELAY_MS);
  };

  const update = (path: string | null, line: number): void => {
    // Позицию запоминаем всегда: когда показ включат, подпись сразу будет для текущей строки.
    const previousPath = position?.path ?? null;
    position = path === null ? null : { path, line };
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (mode === 'off') {
      deps.show(null);
      return;
    }
    if (mode === 'file') {
      // Перешли в другой файл — старые подписи надо убрать, у нового запросить свежие.
      if (annotatedFile !== null && annotatedFile !== path) {
        deps.showAll(annotatedFile, []);
        annotatedFile = null;
      }
      if (position) schedule();
      else clearAll();
      return;
    }
    // Режим строки: подписи всего файла тут лишние.
    if (previousPath !== path) clearAll();
    if (position) schedule();
    else deps.show(null);
  };

  return {
    get enabled() {
      return mode === 'line';
    },
    get mode() {
      return mode;
    },
    toggle() {
      const next = mode === 'line' ? 'off' : 'line';
      mode = next;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (next === 'off') {
        deps.show(null);
        clearAll();
      } else {
        clearAll();
        if (position) schedule();
      }
      return next === 'line';
    },
    toggleFile() {
      const next = mode === 'file' ? 'off' : 'file';
      mode = next;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      deps.show(null);
      if (next === 'off') {
        clearAll();
      } else if (position) {
        schedule();
      }
      return next === 'file';
    },
    update,
    refresh() {
      // Кэш сбрасываем: репозиторий или история могли измениться.
      cache.clear();
      fileCache.clear();
      if (mode !== 'off' && position) schedule();
    },
  };
}
