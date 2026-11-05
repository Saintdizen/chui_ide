import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Возврат из корзины для файлов проекта.
 *
 * `shell.trashItem` ручки не возвращает: корзина у каждого рабочего стола своя,
 * и «вернуть» кроссплатформенно нечем. Поэтому перед отправкой в корзину файл
 * кладётся копией в свою папку возврата — небольшую и недолгую. Тост «Вернуть»
 * возвращает именно эту копию; настоящая корзина остаётся как была.
 *
 * Ограничения честные и нарочитые: только файлы (папка может быть гигабайтом),
 * только до `MAX_BYTES`, и не больше `MAX_ENTRIES` записей — хранилище возврата
 * обязано быть дешёвым, иначе оно станет вторым диском.
 */

/** Файл больше этого не копируем: возврат не должен стоить дороге потери. */
export const MAX_BYTES = 2 * 1024 * 1024;

/** Сколько удалений помним. Дальше вытесняется самое старое. */
export const MAX_ENTRIES = 8;

interface Meta {
  /** Куда файл вернуть. */
  readonly path: string;
  /** Когда удалили (мс): по этому времени и вытесняем. */
  readonly at: number;
}

/** Из id делаем безопасное имя папки: он приходит из renderer. */
function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9-]/g, '');
}

export class TrashUndo {
  /** Основа создаётся лениво: путь userData известен не в конструкторе. */
  constructor(
    private readonly base: () => string,
    /**
     * Подпапка внутри основы. Удалённое и откаты правок лежат раздельно:
     * вытеснение у каждого своё, иначе откат git затирал бы возврат удаления.
     */
    private readonly subfolder = '',
  ) {}

  /**
   * Сохранить копию файла перед отправкой в корзину.
   *
   * `null` — сохранять нечего (папка, слишком большой файл, диск не дал
   * прочитать). Это не ошибка удаления: удаление идёт дальше, просто без возврата.
   */
  async keep(target: string, signal?: AbortSignal): Promise<string | null> {
    const id = await this.save(target, signal);
    // Сразу после записи — порядок вытеснения, как и было раньше.
    if (id) await this.prune();
    return id;
  }

  /**
   * Снимок файла перед действием, которое может стереть правку.
   *
   * Отличается от `keep` нарочно: файл никуда не денется после вызова, и
   * удалять запись за ним некому — `prune` вызывать ЗДЕСЬ нельзя, иначе запись
   * переживёт всего один вызов (см. откат правок git).
   */
  snapshot(target: string, signal?: AbortSignal): Promise<string | null> {
    return this.save(target, signal);
  }

  /**
   * Текст снимка — для возврата содержимого файла, а не самого файла.
   *
   * Отменённый откат должен вернуть ровно тот байт-в-байт текст, который был
   * на диске: перерисовка из редактора потеряла бы переводы строк и хвостовой
   * перевод строки, а файл после такого «возврата» уже не тот.
   */
  async read(id: string): Promise<string | null> {
    try {
      return await fs.readFile(path.join(this.folder(id), 'content'), 'utf8');
    } catch {
      return null;
    }
  }

  private async save(target: string, signal?: AbortSignal): Promise<string | null> {
    try {
      const stat = await fs.stat(target);
      if (!stat.isFile() || stat.size > MAX_BYTES) return null;
      signal?.throwIfAborted();
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const folder = this.folder(id);
      await fs.mkdir(folder, { recursive: true });
      await fs.copyFile(target, path.join(folder, 'content'));
      const meta: Meta = { path: target, at: Date.now() };
      await fs.writeFile(path.join(folder, 'meta.json'), JSON.stringify(meta), 'utf8');
      return id;
    } catch {
      // Снимок — удобство, а не условие действия: любая беда здесь молчит.
      return null;
    }
  }

  /** Вернуть сохранённую копию на место. Путь восстановления — в ответе. */
  async restore(id: string): Promise<string | null> {
    const folder = this.folder(id);
    const meta = await this.readMeta(folder);
    if (!meta) return null;
    try {
      // Родителя могло не стать вместе с файлом — создаём, иначе возврат упрётся.
      await fs.mkdir(path.dirname(meta.path), { recursive: true });
      await fs.copyFile(path.join(folder, 'content'), meta.path);
    } catch {
      return null;
    }
    await this.drop(id);
    return meta.path;
  }

  /**
   * Записать снимок ОБРАТНО в файл и забыть его.
   *
   * В отличие от `restore`, путь берётся из meta самого снимка: откат git —
   * не удаление, и файл на месте, его просто нужно вернуть к прежнему тексту.
   */
  async restoreContent(id: string): Promise<string | null> {
    const folder = this.folder(id);
    const meta = await this.readMeta(folder);
    if (!meta) return null;
    try {
      await fs.copyFile(path.join(folder, 'content'), meta.path);
    } catch {
      return null;
    }
    await this.drop(id);
    return meta.path;
  }

  /** Забыть запись: после успешного возврата или когда она больше не нужна. */
  async drop(id: string): Promise<void> {
    await fs.rm(this.folder(id), { recursive: true, force: true }).catch(() => undefined);
  }

  /** Есть ли что возвращать по этому id (в том числе после перезапуска). */
  async has(id: string): Promise<boolean> {
    return (await this.readMeta(this.folder(id))) !== null;
  }

  /**
   * Оставить только последние записи.
   *
   * Вытеснение по времени, а не по порядку ввода: папка возврата живёт между
   * запусками, и порядок мог быть нарушен копированием руками.
   */
  private async prune(): Promise<void> {
    const base = path.join(this.base(), this.subfolder);
    let names: string[];
    try {
      names = await fs.readdir(base);
    } catch {
      return;
    }
    const entries: { id: string; at: number }[] = [];
    for (const id of names) {
      const meta = await this.readMeta(path.join(base, id));
      if (!meta) {
        // Осиротевшая папка (прерванная запись) — убираем.
        await fs.rm(path.join(base, id), { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      entries.push({ id, at: meta.at });
    }
    entries.sort((left, right) => right.at - left.at);
    for (const stale of entries.slice(MAX_ENTRIES)) {
      await fs.rm(path.join(base, stale.id), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private folder(id: string): string {
    return path.join(this.base(), this.subfolder, safeId(id));
  }

  private async readMeta(folder: string): Promise<Meta | null> {
    try {
      const raw = await fs.readFile(path.join(folder, 'meta.json'), 'utf8');
      const parsed = JSON.parse(raw) as Meta;
      if (typeof parsed.path !== 'string' || typeof parsed.at !== 'number') return null;
      return parsed;
    } catch {
      return null;
    }
  }
}
