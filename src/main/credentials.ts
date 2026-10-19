/**
 * Секреты отдельно от настроек.
 *
 * Ключи провайдеров и сервиса поиска лежали в `settings.json` вместе с размерами
 * шрифта и вкладками. Это плохо по трём причинам: файл настроек копируют в бэкап и
 * пересылают, его правят руками и открывают в редакторе, а ключ — это пароль.
 * Теперь секреты живут в отдельном `credentials.json` рядом с настройками, с
 * правами «только владельцу»: такой файл проще не бэкапить и проще стереть.
 *
 * В renderer секреты не уходят никогда — там только признак «ключ есть»
 * (`hasApiKey`). Здесь живёт хранилище и разбор файла; порядок поиска ключа
 * (файл → переменная окружения) остаётся за `SettingsStore`.
 *
 * Модуль чистый: путь приходит снаружи, `electron` не импортируется. Поэтому он
 * проверяется юнит-тестами, а не только пробой.
 *
 * Перенос из старого `settings.json` делается один раз при первом чтении
 * (см. `takeKeys`): раньше ключ лежал в поле `apiKey` провайдера, и терять его
 * при обновлении нельзя.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Имя файла рядом с `settings.json`. */
export const CREDENTIALS_FILE = 'credentials.json';

/** Что лежит в файле: ключи по провайдерам и ключ сервиса поиска. */
export interface StoredCredentials {
  /** Ключ провайдера модели по его id. */
  providers: Record<string, string>;
  /** Ключ сервиса веб-поиска — он не провайдер модели, поэтому отдельным полем. */
  webSearch?: string;
}

/** Пустой набор: файла ещё нет или он побит. */
export function emptyCredentials(): StoredCredentials {
  return { providers: {} };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cleanKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Разобрать файл ключей. Побитое — пустой набор, а не отказ: без ключа IDE просто
 * попросит его ввести, а падать из-за правки файла руками незачем.
 */
export function parseCredentials(raw: unknown): StoredCredentials {
  const record = asRecord(raw);
  if (!record) return emptyCredentials();

  const providers: Record<string, string> = {};
  const source = asRecord(record.providers);
  if (source) {
    for (const [id, value] of Object.entries(source)) {
      const key = cleanKey(value);
      if (key && id.trim() !== '') providers[id.trim()] = key;
    }
  }

  const webSearch = cleanKey(record.webSearch);
  return webSearch ? { providers, webSearch } : { providers };
}

/** Ключи, которые лежали в старом `settings.json`. */
export interface LegacyKeys {
  /** Провайдеры в виде `{ id, apiKey }`: остальное при переносе не нужно. */
  providers: readonly { id?: unknown; apiKey?: unknown }[];
  /** Ключ сервиса поиска из `ai.webSearch.apiKey`. */
  webSearch?: unknown;
}

/**
 * Забрать ключи из старого файла настроек.
 *
 * Возвращает только секреты и признак «что-то нашлось»: переписывать настройки
 * решает вызывающий, а не разбор. Ключи в настройках при этом остаются — их
 * удаление делает тот, кто пишет файл, иначе разбор пришлось бы делать дважды.
 */
export function takeKeys(legacy: LegacyKeys): { secrets: StoredCredentials; found: boolean } {
  const secrets = emptyCredentials();
  let found = false;
  for (const provider of legacy.providers) {
    const id = typeof provider.id === 'string' ? provider.id.trim() : '';
    const key = cleanKey(provider.apiKey);
    if (!id || !key) continue;
    secrets.providers[id] = key;
    found = true;
  }
  const webSearch = cleanKey(legacy.webSearch);
  if (webSearch) {
    secrets.webSearch = webSearch;
    found = true;
  }
  return { secrets, found };
}

/**
 * Хранилище секретов. Читается один раз в память, пишется на каждое изменение:
 * файл маленький, а «тихая» потеря ключа при падении дороже лишней записи.
 *
 * Права — `0600`: читать и писать может только владелец. Ставим и при создании,
 * и после записи: `writeFile` применяет режим только к новому файлу, а файл мог
 * остаться от прежней версии с правами пошире.
 */
export class CredentialsStore {
  private data: StoredCredentials;

  constructor(private readonly filePath: string) {
    this.data = this.read();
  }

  file(): string {
    return this.filePath;
  }

  private read(): StoredCredentials {
    try {
      return parseCredentials(JSON.parse(readFileSync(this.filePath, 'utf8')));
    } catch {
      // Файла нет или он побит: начинаем с пустого набора.
      return emptyCredentials();
    }
  }

  /** Ключ провайдера. `undefined` — не задан. */
  get(providerId: string): string | undefined {
    return this.data.providers[providerId];
  }

  /** Сохранить или заменить ключ. Пустая строка стирает — как `clearApiKey`. */
  set(providerId: string, apiKey: string): void {
    const key = cleanKey(apiKey);
    if (key) this.data.providers[providerId] = key;
    else delete this.data.providers[providerId];
    this.persist();
  }

  remove(providerId: string): void {
    if (!(providerId in this.data.providers)) return;
    delete this.data.providers[providerId];
    this.persist();
  }

  getWebSearch(): string | undefined {
    return this.data.webSearch;
  }

  setWebSearch(apiKey: string): void {
    const key = cleanKey(apiKey);
    if (key) this.data.webSearch = key;
    else delete this.data.webSearch;
    this.persist();
  }

  /**
   * Доложить ключи из старого файла настроек. Существующие не перетираются: если
   * человек уже успел ввести новый ключ, старый из бэкапа его не заменит.
   */
  adopt(secrets: StoredCredentials): boolean {
    let changed = false;
    for (const [id, key] of Object.entries(secrets.providers)) {
      if (this.data.providers[id] !== undefined) continue;
      this.data.providers[id] = key;
      changed = true;
    }
    if (secrets.webSearch && this.data.webSearch === undefined) {
      this.data.webSearch = secrets.webSearch;
      changed = true;
    }
    if (changed) this.persist();
    return changed;
  }

  /** Есть ли хоть один ключ: по этому признаку панель говорит «сохранён». */
  isEmpty(): boolean {
    return Object.keys(this.data.providers).length === 0 && this.data.webSearch === undefined;
  }

  private persist(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    // Файл мог существовать раньше с другими правами: режим создания его не меняет.
    try {
      chmodSync(temporary, 0o600);
    } catch {
      // Windows не знает POSIX-прав: файл и так доступен только пользователю.
    }
    renameSync(temporary, this.filePath);
  }
}

/** Путь к файлу ключей рядом с настройками: `…/credentials.json`. */
export function credentialsPathFor(settingsPath: string): string {
  return path.join(path.dirname(settingsPath), CREDENTIALS_FILE);
}
