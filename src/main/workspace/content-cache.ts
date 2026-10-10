/**
 * Кэш содержимого файлов для поиска.
 *
 * Замерено: в обходе проекта дорого именно чтение файлов, а не обход и не `stat`.
 * На дереве в 7,5 тысяч файлов обход стоит 87 мс, `stat` каждого — 84 мс, а чтение
 * всех — 788 мс. Поиск же по уже прочитанному тексту — 30 мс. Значит повторный
 * поиск незачем читать заново: содержимое неизменённых файлов держим в памяти, а
 * на диске сверяем только `mtime` и размер.
 *
 * Это не «семантический индекс» и не эмбеддинги — просто кэш; зато он не требует
 * ни сети, ни новых зависимостей и не меняет результаты поиска.
 *
 * Свежесть важнее скорости: `mtime` и размер проверяются перед каждым
 * использованием, поэтому правка файла снаружи видна сразу. Кэш — подспорье, а не
 * источник истины; при малейшем сомнении читаем с диска.
 */

/** Что помним про файл: его версию и текст. */
export interface CachedFile {
  mtimeMs: number;
  size: number;
  text: string;
}

export interface ContentCacheStats {
  entries: number;
  bytes: number;
  hits: number;
  misses: number;
}

/**
 * Потолок памяти под содержимое. Дерево в 7,5 тысяч файлов — это около 78 МБ
 * текста, и держать его целиком нельзя: main-процесс живёт долго, а поиск по
 * такому дереву — редкий случай. 48 МБ хватает обычному проекту с запасом.
 */
export const DEFAULT_CACHE_BYTES = 48 * 1024 * 1024;

export class ContentCache {
  /**
   * `Map` хранит порядок вставки, поэтому он же служит очередью вытеснения:
   * обращение переносит запись в конец (`get` удаляет и ставит заново), а
   * вытесняем всегда самую старую — первую.
   */
  private readonly entries = new Map<string, CachedFile>();
  private bytes = 0;
  private hits = 0;
  private misses = 0;

  constructor(private readonly maxBytes: number = DEFAULT_CACHE_BYTES) {}

  /** Текст файла, если он в кэше и версия совпала. Иначе `null` — читай с диска. */
  get(filePath: string, mtimeMs: number, size: number): string | null {
    const entry = this.entries.get(filePath);
    if (!entry) {
      this.misses += 1;
      return null;
    }
    if (entry.mtimeMs !== mtimeMs || entry.size !== size) {
      // Файл изменился: старая версия не просто бесполезна, она вредна — поиск
      // нашёл бы текст, которого в файле уже нет.
      this.drop(filePath);
      this.misses += 1;
      return null;
    }

    // Обращение — это «нужен ещё»: переносим в конец очереди вытеснения.
    this.entries.delete(filePath);
    this.entries.set(filePath, entry);
    this.hits += 1;
    return entry.text;
  }

  /** Запомнить содержимое. Файл больше потолка кэша не трогаем: он вытеснит всё. */
  set(filePath: string, mtimeMs: number, size: number, text: string): void {
    if (text.length > this.maxBytes) return;

    const previous = this.entries.get(filePath);
    if (previous) this.bytes -= previous.text.length;
    else this.entries.delete(filePath);

    this.entries.set(filePath, { mtimeMs, size, text });
    this.bytes += text.length;
    this.evict();
  }

  /** Забыть файл: он изменился от нас или удалён. */
  invalidate(filePath: string): void {
    this.drop(filePath);
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  stats(): ContentCacheStats {
    return { entries: this.entries.size, bytes: this.bytes, hits: this.hits, misses: this.misses };
  }

  /** Только для проверок: обнулить счётчики, не трогая содержимое. */
  resetCounters(): void {
    this.hits = 0;
    this.misses = 0;
  }

  private drop(filePath: string): void {
    const entry = this.entries.get(filePath);
    if (!entry) return;
    this.entries.delete(filePath);
    this.bytes -= entry.text.length;
  }

  /** Вытеснение: выбрасываем самые старые записи, пока не влезем в потолок. */
  private evict(): void {
    for (const [key, entry] of this.entries) {
      if (this.bytes <= this.maxBytes) return;
      this.entries.delete(key);
      this.bytes -= entry.text.length;
    }
  }
}
