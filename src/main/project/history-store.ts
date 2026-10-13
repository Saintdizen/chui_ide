import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  MAX_HISTORY_BYTES,
  MAX_HISTORY_ENTRIES,
  countLines,
  historyKey,
  sanitizeHistoryEntries,
  type HistoryEntry,
  type HistoryReason,
} from '../../shared/file-history';

/** Индекс рабочей области: путь файла → его снимки, новые в начале. */
interface HistoryIndex {
  version: 1;
  files: Record<string, HistoryEntry[]>;
}

/** Идентификатор должен быть годен и как имя файла, и как аргумент возврата. */
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i;

/**
 * Локальная история: снимки содержимого файлов проекта.
 *
 * Раскладка — по рабочей области, как у сессий (`session-store.ts`): на каждый
 * корень свой каталог `<base>/<имя>-<hash>/`. Внутри `index.json` (путь → список
 * снимков, новые в начале) и по файлу `<id>.txt` на сам снимок. Содержимое лежит
 * отдельно от индекса: перезаписать маленький индекс дёшево, а снимки — это данные,
 * и их не хочется таскать через каждую правку списка.
 *
 * Каталог задаётся снаружи (в приложении — `userData/history`), поэтому модуль не
 * тянет Electron и проверяется тестами с временным каталогом.
 *
 * История вспомогательная: сбой записи снимка не должен ронять сохранение файла,
 * поэтому наружу отсюда ничего не летит — вызывающий `capture` просто не отдаёт
 * ошибку дальше.
 */
export class HistoryStore {
  /** Очередь записей по каталогу: два быстрых сохранения не должны потерять снимок. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly base: string) {}

  /**
   * Отложить текущее содержимое файла перед перезаписью.
   *
   * Повтор того же текста не сохраняем: частые сохранения без правок иначе забили
   * бы список одинаковыми копиями (сравниваем по отпечатку содержимого, а не по
   * времени — `mtime` у двух записей подряд может совпасть).
   */
  async capture(root: string, filePath: string, reason: HistoryReason = 'save'): Promise<void> {
    if (!root || !filePath) return;
    const file = path.resolve(filePath);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile() || stat.size > MAX_HISTORY_BYTES) return;
    const buffer = await fs.readFile(file).catch(() => null);
    if (!buffer) return;

    const text = buffer.toString('utf8').replace(/\r\n/g, '\n');
    const hash = fingerprint(text);
    const key = historyKey(root, file);

    await this.withWorkspace(root, async (index) => {
      const entries = index.files[key] ?? [];
      if (reason === 'save' && entries[0]?.hash === hash) return;
      const id = makeId();
      const dir = this.dirFor(root);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `${id}.txt`), text, 'utf8');
      const entry: HistoryEntry = {
        id,
        path: file,
        name: path.basename(file),
        mtimeMs: Math.round(stat.mtimeMs),
        size: buffer.byteLength,
        lines: countLines(text),
        hash,
        reason,
      };
      const all = [entry, ...entries];
      // Вытесненные снимки убираем и с диска: индекс — не единственное место,
      // где живёт история, иначе файлы копились бы без предела.
      for (const dropped of all.slice(MAX_HISTORY_ENTRIES)) {
        await fs.rm(path.join(dir, `${dropped.id}.txt`), { force: true }).catch(() => undefined);
      }
      index.files[key] = all.slice(0, MAX_HISTORY_ENTRIES);
    });
  }

  /** Снимки файла, новые в начале. */
  async list(root: string, filePath: string): Promise<HistoryEntry[]> {
    if (!root || !filePath) return [];
    const index = await this.readIndex(root);
    return index.files[historyKey(root, path.resolve(filePath))] ?? [];
  }

  /** Содержимое снимка. `null` — снимка нет (индекс устарел, файл удалили). */
  async read(root: string, filePath: string, id: string): Promise<string | null> {
    if (!root || !filePath || !ID_PATTERN.test(id)) return null;
    const index = await this.readIndex(root);
    const entry = (index.files[historyKey(root, path.resolve(filePath))] ?? []).find((item) => item.id === id);
    if (!entry) return null;
    return fs.readFile(path.join(this.dirFor(root), `${entry.id}.txt`), 'utf8').catch(() => null);
  }

  /** Убрать историю файла целиком: и записи, и сами снимки на диске. */
  async clear(root: string, filePath: string): Promise<void> {
    if (!root || !filePath) return;
    const key = historyKey(root, path.resolve(filePath));
    await this.withWorkspace(root, async (index) => {
      const entries = index.files[key] ?? [];
      for (const entry of entries) {
        await fs.rm(path.join(this.dirFor(root), `${entry.id}.txt`), { force: true }).catch(() => undefined);
      }
      delete index.files[key];
    });
  }

  /** Каталог рабочей области: имя проекта для читаемости плюс хеш пути для уникальности. */
  private dirFor(root: string): string {
    const resolved = path.resolve(root);
    const hash = createHash('sha1').update(resolved).digest('hex').slice(0, 12);
    const safe =
      path
        .basename(resolved)
        .replace(/[^\w.-]+/g, '_')
        .slice(0, 40) || 'workspace';
    return path.join(this.base, `${safe}-${hash}`);
  }

  /** Прочитать индекс и сохранить его после работы — под замком, по одному на каталог. */
  private async withWorkspace(root: string, work: (index: HistoryIndex) => Promise<void>): Promise<void> {
    const dir = this.dirFor(root);
    const previous = this.queues.get(dir) ?? Promise.resolve();
    const run = previous.then(async () => {
      const index = await this.readIndex(root);
      await work(index);
      await writeIndex(dir, index);
    });
    // Сбой одного снимка не должен задерживать следующий: очередь продолжается,
    // а ошибку мы сознательно не разносим — история вспомогательная.
    this.queues.set(
      dir,
      run.catch(() => undefined),
    );
    await run.catch(() => undefined);
  }

  private async readIndex(root: string): Promise<HistoryIndex> {
    try {
      const raw: unknown = JSON.parse(await fs.readFile(path.join(this.dirFor(root), 'index.json'), 'utf8'));
      return parseIndex(raw);
    } catch {
      // Нет индекса или он повреждён — истории просто нет, а не ошибка открытия.
      return { version: 1, files: {} };
    }
  }
}

function parseIndex(raw: unknown): HistoryIndex {
  const files: Record<string, HistoryEntry[]> = {};
  if (raw && typeof raw === 'object') {
    const source = (raw as { files?: unknown }).files;
    if (source && typeof source === 'object') {
      for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
        const entries = sanitizeHistoryEntries(value);
        if (entries.length > 0) files[key] = entries;
      }
    }
  }
  return { version: 1, files };
}

/** Запись индекса через временный файл: оборванная запись не оставит битый JSON. */
async function writeIndex(dir: string, index: HistoryIndex): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'index.json');
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(index)}\n`, 'utf8');
  await fs.rename(temporary, file);
}

function makeId(): string {
  return `${Date.now().toString(36)}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

function fingerprint(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 16);
}
