/**
 * Написания одного пути в отладке.
 *
 * Отладчик называет файл по-своему, и это не придирка, а факт: на macOS `/var` —
 * это `/private/var`, на Windows мешают регистр и короткие имена (`RUNNER~1`), а
 * если проект открыт по симлинку, отладчик всё равно доложит настоящий путь.
 * Клиенту же нужен тот путь, которым файл открыт в редакторе: по чужому
 * написанию renderer файл не найдёт — ни кадра, ни точки останова.
 *
 * У Node-адаптера такая карта уже есть (`node-adapter.ts`: `canonicalPath` и
 * `aliases`); здесь то же правило вынесено отдельно, потому что оно нужно и
 * Python-отладке, где адаптер чужой (`debugpy`) и подменить его нельзя.
 *
 * Модуль чистый: развёртывание симлинков делает вызывающий (это работа с
 * диском), сюда приходит уже готовый настоящий путь.
 */

/**
 * Ключ сравнения путей: разделители к одному виду, регистр — только на Windows.
 * Без приведения разделителей `C:\proj\app.py` и `C:/proj/app.py` считались бы
 * разными файлами, хотя это один и тот же путь.
 */
export function debugPathKey(value: string, caseInsensitive: boolean): string {
  const slashed = value.replace(/\\/g, '/');
  return caseInsensitive ? slashed.toLowerCase() : slashed;
}

/**
 * Карта «настоящий путь → написание клиента». Запоминаем только расхождения:
 * если отладчик назовёт файл так же, как назвали его мы, карта не нужна.
 */
export class PathAliases {
  /** Ключ настоящего пути → написание клиента (и наоборот): нужны оба направления. */
  private readonly byCanonical = new Map<string, string>();
  private readonly byOriginal = new Map<string, string>();

  constructor(private readonly caseInsensitive: boolean) {}

  get size(): number {
    return this.byCanonical.size;
  }

  private key(value: string): string {
    return debugPathKey(value, this.caseInsensitive);
  }

  /** Забыть всё, что известно про этот файл (в любом написании). */
  private forget(original: string, canonical: string | null): void {
    const own = this.key(original);
    const real = canonical ? this.key(canonical) : null;
    // Прошлая запись могла связывать этот файл с другим написанием: убираем и её,
    // иначе карта вернула бы путь, которым файл больше не открыт. Читаем запись
    // до удаления — после её уже нет.
    const stale = this.byOriginal.get(own);
    if (stale) this.byCanonical.delete(this.key(stale));
    this.byOriginal.delete(own);
    if (real) this.byCanonical.delete(real);
  }

  /**
   * Запомнить, что клиент называет файл `original`, а на диске он лежит по
   * `canonical`. `canonical` может быть `null` — файла ещё нет или путь не
   * разрешился: тогда запоминать нечего.
   */
  remember(original: string, canonical: string | null): void {
    this.forget(original, canonical);
    if (!canonical) return;
    const own = this.key(original);
    const real = this.key(canonical);
    // Совпало — карта не нужна: отладчик назовёт файл так же, как мы.
    if (real === own) return;
    this.byCanonical.set(real, original);
    this.byOriginal.set(own, canonical);
  }

  /** Написание клиента для пути, которым файл назвал отладчик. */
  resolve(reported: string): string {
    return this.byCanonical.get(this.key(reported)) ?? reported;
  }

  /**
   * Написание, которое стоит отдать отладчику: настоящий путь, если он известен.
   * Отладчик ищет файл на диске, поэтому настоящее написание — то, что он
   * наверняка поймёт. Возвращаем путь как есть, а не ключ: на Windows ключ
   * приведён к нижнему регистру, и отдавать его было бы искажением пути.
   */
  canonicalFor(original: string): string {
    return this.byOriginal.get(this.key(original)) ?? original;
  }

  clear(): void {
    this.byCanonical.clear();
    this.byOriginal.clear();
  }
}
