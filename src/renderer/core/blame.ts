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
  /** Показать подпись у строки; `null` — убрать. */
  show(annotation: BlameAnnotation | null): void;
}

export interface BlameController {
  readonly enabled: boolean;
  /** Включить или выключить показ; возвращает новое состояние. */
  toggle(): boolean;
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
  let enabled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Номер последнего запроса: ответ с меньшим номером — устаревший. */
  let requestId = 0;
  /** Текущая позиция: с ней сверяется ответ, когда он придёт. */
  let position: { path: string; line: number } | null = null;
  const cache = new Map<string, string | null>();

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

  const schedule = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const current = position;
      if (current) void request(current.path, current.line);
    }, REQUEST_DELAY_MS);
  };

  const update = (path: string | null, line: number): void => {
    // Позицию запоминаем всегда: когда показ включат, подпись сразу будет для текущей строки.
    position = path === null ? null : { path, line };
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (!enabled) {
      deps.show(null);
      return;
    }
    if (position) schedule();
    else deps.show(null);
  };

  return {
    get enabled() {
      return enabled;
    },
    toggle() {
      enabled = !enabled;
      if (!enabled) {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        deps.show(null);
      } else if (position) {
        schedule();
      }
      return enabled;
    },
    update,
    refresh() {
      // Кэш сбрасываем: репозиторий или история могли измениться.
      cache.clear();
      if (enabled && position) schedule();
    },
  };
}
