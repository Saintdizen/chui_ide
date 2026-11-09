import { promises as fs } from 'node:fs';

/**
 * Кэш ответов поиска по содержимому: ключ запроса и версии файлов, где он нашёлся.
 *
 * Зачем: `search` — второй по цене ответ после `read`, а в переписи повторяется:
 * модель ищет одно и то же имя дважды за прогон (сначала как `agent-read`, потом как
 * `agent-read\.ts`), а после правки одного файла прогоняет тот же запрос по дереву
 * заново. Ответ поиска меняется только вместе с файлами, где он нашёлся, — их
 * версия (`mtime` + размер) и есть ключ.
 *
 * Версия файла, а не всего проекта: правка `service.ts` не должна сбрасывать
 * результат по `tools.ts`. Файлы, которых в ответе не было, в ключ не входят —
 * но новый файл с совпадением тоже не появится в старом ответе, поэтому ключ
 * включает ещё и отметку последней записи в проекте (`tree`).
 *
 * Метрика — не для украшения: без числа попаданий непонятно, окупается ли кэш, и
 * по правилу среза каждый пункт экономии закрывается замером.
 */

export interface SearchCacheKey {
  /** Имя инструмента и действие: у `search` и `search` с `filesOnly` ответы разные. */
  readonly call: string;
  /** Запрос целиком: текст, регулярка, учёт регистра. */
  readonly query: string;
  /** Файлы ответа (пути проекта) и их версии (`mtime:size`, `gone`) — парой. */
  readonly files: readonly string[];
  readonly versions: readonly string[];
  /** Отметка записи в проекте: новый файл с совпадением меняет ответ. */
  readonly tree: string;
  /** Сколько совпадений отдаём: другой `limit` — другой ответ. */
  readonly limit: number;
}

export interface SearchCacheEntry {
  readonly outcome: unknown;
  /** Сколько символов отдали в первый раз: столько же сэкономлено попаданием. */
  readonly chars: number;
  readonly files: readonly string[];
  readonly versions: readonly string[];
}

export interface SearchCacheStats {
  /** Сколько раз ответ взят из кэша. */
  readonly hits: number;
  /** Сколько раз ответ пришлось считать. */
  readonly misses: number;
  /** Сколько символов ответов не пришлось считать заново. */
  readonly savedChars: number;
}

/** Потолок записей: кэш — не архив, ему хватает нескольких десятков ответов. */
export const SEARCH_CACHE_LIMIT = 64;

/**
 * Кэш поиска: `Map` в порядке вставки, вытеснение — самый старый.
 *
 * LRU без счётчика обращений: попадание переставляет запись в конец (`Map`
 * сохраняет порядок вставки), значит, первой уходит та, что дольше всех не нужна.
 */
export class SearchCache {
  private readonly entries = new Map<string, SearchCacheEntry>();
  private hits = 0;
  private misses = 0;
  private savedChars = 0;

  constructor(private readonly limit = SEARCH_CACHE_LIMIT) {}

  /** Ключ в строку — без версий: версии сверяются отдельно, до попадания. */
  static keyOf(key: SearchCacheKey): string {
    return `${key.call}\u0000${key.query}\u0000${key.limit}\u0000${key.tree}`;
  }

  /** Версии файлов записи: по ним видно, не устарел ли ответ. */
  versionsOf(key: SearchCacheKey): readonly string[] | undefined {
    return this.entries.get(SearchCache.keyOf(key))?.versions;
  }

  /** Файлы, от которых зависит ответ, — когда запись уже есть. */
  filesOf(key: SearchCacheKey): readonly string[] | undefined {
    return this.entries.get(SearchCache.keyOf(key))?.files;
  }

  get(key: SearchCacheKey): unknown | undefined {
    const id = SearchCache.keyOf(key);
    const entry = this.entries.get(id);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    // Попадание — запись в конец очереди вытеснения.
    this.entries.delete(id);
    this.entries.set(id, entry);
    this.hits += 1;
    this.savedChars += entry.chars;
    return entry.outcome;
  }

  set(key: SearchCacheKey, outcome: unknown, chars: number): void {
    const id = SearchCache.keyOf(key);
    this.entries.delete(id);
    this.entries.set(id, { outcome, chars, files: key.files, versions: key.versions });
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Правка файла: ответы, где он был, больше не верны. */
  forgetFile(path: string): void {
    for (const [id, entry] of this.entries) {
      if (entry.files.includes(path)) this.entries.delete(id);
    }
  }

  /** Правка во всём проекте (`tree`): сбрасываем всё, что висело на старой отметке. */
  forgetTree(): void {
    this.entries.clear();
  }

  stats(): SearchCacheStats {
    return { hits: this.hits, misses: this.misses, savedChars: this.savedChars };
  }

  size(): number {
    return this.entries.size;
  }
}

/**
 * Версия файлов и записи проекта: `mtime` + размер, без чтения содержимого.
 *
 * `stat` одного файла — микросекунды, а `search` по дереву — миллисекунды и
 * десятки тысяч символов ответа. Отметку записи берём с корня проекта: новый
 * файл меняет `mtime` папки, а он и нужен — без него старый ответ спрятал бы его.
 */
export async function fileVersions(paths: readonly string[]): Promise<string[]> {
  const versions = await Promise.all(
    paths.map(async (file) => {
      try {
        const info = await fs.stat(file);
        return `${info.mtimeMs}:${info.size}`;
      } catch {
        // Файла нет — версия «удалён»: ответ с ним больше не верен.
        return 'gone';
      }
    }),
  );
  return versions;
}

/** Отметка папки проекта: правка любого файла в корне её меняет. */
export async function treeStamp(root: string | null): Promise<string> {
  if (!root) return 'no-root';
  try {
    const info = await fs.stat(root);
    return `${info.mtimeMs}`;
  } catch {
    return 'gone';
  }
}
