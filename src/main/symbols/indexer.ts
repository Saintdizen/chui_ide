import { promises as fs } from 'node:fs';
import path from 'node:path';
import { languageInfoForPath } from '../../shared/languages';
import type { FileSymbol, ProjectSymbol } from '../../shared/lsp-symbols';
import { findEntryPoints, isTestFile } from '../../shared/project-scan';
import {
  basesByLine,
  isIndexedLanguage,
  queryIndex,
  toIndexDecls,
  type IndexedFile,
  type SymbolIndexStatus,
} from '../../shared/symbol-index';
import { listProjectFiles } from '../project/scan';
import type { SymbolStore } from './store';

/**
 * Сборка карты символов: объявления всех файлов проекта Python или Node без тел.
 *
 * Источник объявлений — языковой сервер (`textDocument/documentSymbol`): разбирать
 * код своим парсером значило бы держать второй разбор, который рано или поздно
 * разойдётся с сервером. Карта лишь сохраняет ответ сервера в удобной форме и на
 * диск, чтобы следующая сессия не ждала разбора заново.
 *
 * Обход идёт в фоне и порциями: карта не должна подвешивать запуск IDE. Пока она
 * собирается (`warming`), поиск отвечает тем, что уже собрано, — это и есть «глупый
 * режим»: подсказки не молчат, просто знают меньше.
 *
 * Что разбирается заново: файлы, у которых изменился размер или время изменения.
 * Отпечаток сверяется по диску при каждом обходе, поэтому правка одного файла не
 * стоит разбора всего проекта.
 */

/** Сколько файлов карта готова разобрать за один прогон: остальное — в следующий раз. */
const MAX_PARSE_PER_RUN = 2000;

/** Файл крупнее этого в карту не берём: объявлений там мало, а чтение дорогое. */
const MAX_FILE_BYTES = 512 * 1024;

/** Как часто сохранять промежуточный результат: сбой посреди обхода не должен терять всё. */
const SAVE_EVERY = 40;

/**
 * Пауза перед разбором сохранённого файла. Сохранения идут пачкой (сохранить всё,
 * форматирование, массовая замена), и разбирать каждое по отдельности — значит
 * спрашивать сервер несколько раз за долю секунды.
 */
const TOUCH_DELAY_MS = 250;

/** Пауза перед записью кэша на диск: файл один и большой, а правки идут подряд. */
const SAVE_DELAY_MS = 3000;

export interface SymbolIndexDeps {
  /** Корень открытого проекта; `null` — проекта нет, карту собирать не по чему. */
  root(): string | null;
  /** Скелет файла у языкового сервера: `null` — сервера нет или он не умеет. */
  outline(path: string, languageId: string, text: string): Promise<readonly FileSymbol[] | null>;
  store: SymbolStore;
}

export class SymbolIndexer {
  private phase: SymbolIndexStatus['phase'] = 'idle';
  private root: string | null = null;
  private files = new Map<string, IndexedFile>();
  private skipped = 0;
  private running: Promise<void> | null = null;
  /** Файлы, которые правили после сборки: их объявления уже устарели. */
  private readonly touched = new Set<string>();
  private touchTimer: NodeJS.Timeout | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  /** Идущий разбор сохранённых файлов: `settled` ждёт и его тоже. */
  private applying: Promise<void> | null = null;

  constructor(private readonly deps: SymbolIndexDeps) {}

  /** Что карта знает сейчас. */
  status(): SymbolIndexStatus {
    let decls = 0;
    for (const file of this.files.values()) decls += file.decls.length;
    return { root: this.root, phase: this.phase, files: this.files.size, decls, skipped: this.skipped };
  }

  /**
   * Запустить сборку в фоне. Повторный зов ничего не ломает: пока прогон идёт, второй
   * не начинается — читать проект дважды разом незачем.
   */
  refresh(): void {
    if (this.running) return;
    this.running = this.run()
      .catch(() => undefined)
      .finally(() => {
        this.running = null;
      });
  }

  /**
   * Дождаться текущей работы — нужно проверкам и пробе, человеку не нужно никогда.
   * Ждём и полный обход, и разбор сохранённых файлов: для спрашивающего это одно и то же
   * «карта догнала диск».
   */
  async settled(): Promise<void> {
    for (let work = this.running ?? this.applying; work; work = this.running ?? this.applying) {
      await work.catch(() => undefined);
    }
  }

  /**
   * Где объявлено имя: по карте, без сервера и без ожидания. Пока карта собирается,
   * ответ неполный — но он есть, и это лучше пустого списка.
   */
  find(query: string, limit = 50): ProjectSymbol[] {
    return queryIndex(this.files.values(), query, limit);
  }

  /**
   * Файл изменился: перечитать его объявления.
   *
   * Зовётся на каждое сохранение и на чужую правку в рабочей папке (наблюдатель за
   * корнем). Пересобирать ради этого весь проект незачем: правка касается одного
   * файла, и он же — единственный, кого надо переспросить у сервера. Карта поэтому не
   * отстаёт от кода: поиск символа видит следом за сохранением, а не после смены проекта.
   *
   * Путь не из проекта и файл не нашего языка — не наше дело: молча мимо.
   */
  noteChanged(target: string): void {
    const root = this.root ?? this.deps.root();
    if (!root) return;
    const relative = path.relative(root, target).split(path.sep).join('/');
    // `..` в начале — файл вне проекта: его объявления к этой карте не относятся.
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return;
    if (!isIndexedLanguage(languageInfoForPath(relative)?.id)) return;

    this.touched.add(relative);
    if (this.touchTimer) return;
    this.touchTimer = setTimeout(() => {
      this.touchTimer = null;
      this.applying = this.applyTouched().finally(() => {
        this.applying = null;
      });
    }, TOUCH_DELAY_MS);
    // Таймер не держит процесс: карта — ускорение, а не причина не закрывать окно.
    this.touchTimer.unref?.();
  }

  /** Разобрать накопившиеся правки по одной и отложить запись кэша. */
  private async applyTouched(): Promise<void> {
    const root = this.root;
    if (!root) {
      this.touched.clear();
      return;
    }
    // Полный обход мог идти в этот момент: он перезапишет карту своим снимком,
    // поэтому сперва ждём его, а потом правим — иначе правка потерялась бы. Ждём именно
    // обход: `settled` ждёт и текущий разбор, то есть этот самый — было бы ожидание себя.
    while (this.running) await this.running;
    if (this.deps.root() !== root) {
      this.touched.clear();
      return;
    }

    const pending = [...this.touched];
    this.touched.clear();
    for (const relative of pending) await this.reindexFile(root, relative);
    this.saveSoon();
  }

  /** Перечитать один файл. Тот же путь, что у полного обхода: стат, текст, скелет, предки. */
  private async reindexFile(root: string, relative: string): Promise<void> {
    const absolute = path.join(root, ...relative.split('/'));
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat?.isFile()) {
      // Файл удалили или переименовали: объявлений по старому пути больше нет.
      this.files.delete(relative);
      return;
    }

    const known = this.files.get(relative);
    const mtime = Math.floor(stat.mtimeMs);
    if (known && known.size === stat.size && known.mtime === mtime) return;
    if (stat.size > MAX_FILE_BYTES) {
      this.files.delete(relative);
      return;
    }

    const text = await fs.readFile(absolute, 'utf8').catch(() => null);
    if (text === null) return;
    const language = languageInfoForPath(relative)?.id ?? '';
    const symbols = await this.deps.outline(absolute, language, text).catch(() => null);
    // Сервер молчит — оставляем прежние объявления: пустая карта по файлу хуже
    // устаревшей, потому что поиск перестал бы находить и то, что было.
    if (symbols === null) return;

    const bases = basesByLine(text, language);
    this.files.set(relative, {
      path: relative,
      language,
      size: stat.size,
      mtime,
      decls: toIndexDecls(symbols, (line) => bases.get(line) ?? []),
    });
  }

  /** Записать карту с задержкой: несколько сохранений подряд дают одну запись. */
  private saveSoon(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const root = this.root;
      if (!root) return;
      void this.deps.store.save(root, [...this.files.values()]);
    }, SAVE_DELAY_MS);
    this.saveTimer.unref?.();
  }

  private async run(): Promise<void> {
    const root = this.deps.root();
    if (!root) {
      this.phase = 'idle';
      this.root = null;
      this.files.clear();
      this.skipped = 0;
      return;
    }

    // Сменился проект — прежние объявления к нему не относятся.
    if (this.root !== root) {
      this.root = root;
      this.files.clear();
      this.skipped = 0;
    }

    this.phase = 'warming';
    const cached = new Map<string, IndexedFile>();
    for (const file of await this.deps.store.load(root)) cached.set(file.path, file);

    const listing = await listProjectFiles(root).catch(() => null);
    if (!listing) {
      this.phase = 'ready';
      return;
    }

    const next = new Map<string, IndexedFile>();
    let parsed = 0;
    let skipped = 0;
    let sinceSave = 0;

    for (const relative of orderFiles(listing.files)) {
      // Проект могли сменить, пока шёл обход: чужие объявления не сохраняем.
      if (this.deps.root() !== root) return;

      const absolute = path.join(root, ...relative.split('/'));
      const stat = await fs.stat(absolute).catch(() => null);
      if (!stat?.isFile()) continue;

      const mtime = Math.floor(stat.mtimeMs);
      const known = cached.get(relative);
      if (known && known.size === stat.size && known.mtime === mtime) {
        next.set(relative, known);
        continue;
      }

      // Бюджет кончился: что уже знали — оставляем, остальное дособерётся в следующий раз.
      if (parsed >= MAX_PARSE_PER_RUN) {
        if (known) next.set(relative, known);
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) {
        skipped += 1;
        continue;
      }

      const text = await fs.readFile(absolute, 'utf8').catch(() => null);
      if (text === null) continue;
      parsed += 1;

      const language = languageInfoForPath(relative)?.id ?? '';
      const symbols = await this.deps.outline(absolute, language, text).catch(() => null);
      // `null` — сервер не ответил (не поднят, не умеет). Такое не кэшируем: в следующий
      // раз спросим снова, иначе файл навсегда остался бы без объявлений.
      if (symbols === null) {
        skipped += 1;
        continue;
      }

      // Предков разбираем по тексту: в скелете их нет, а без них карта не скажет,
      // что класс получает от родителей.
      const bases = basesByLine(text, language);
      next.set(relative, {
        path: relative,
        language,
        size: stat.size,
        mtime,
        decls: toIndexDecls(symbols, (line) => bases.get(line) ?? []),
      });

      sinceSave += 1;
      if (sinceSave >= SAVE_EVERY) {
        sinceSave = 0;
        this.files = new Map(next);
        await this.deps.store.save(root, [...next.values()]);
      }
    }

    this.files = next;
    this.skipped = skipped;
    this.phase = 'ready';
    await this.deps.store.save(root, [...next.values()]);
  }
}

/**
 * В каком порядке разбирать файлы: точки входа, потом обычный код, потом тесты.
 *
 * Порядок важен тем, что карта ценна уже на середине обхода: бюджет может кончиться
 * (и обход может прерваться сменой проекта), а то, с чего программа начинается,
 * человек ищет первым. Заодно отсеиваются не наши языки — карта собирается не для всех.
 */
export function orderFiles(files: readonly string[]): string[] {
  const entries = new Set(findEntryPoints(files, 32));
  const first: string[] = [];
  const tests: string[] = [];

  for (const file of files) {
    if (!isIndexedLanguage(languageInfoForPath(file)?.id)) continue;
    if (isTestFile(file)) tests.push(file);
    else if (entries.has(file)) first.unshift(file);
    else first.push(file);
  }

  return [...first, ...tests];
}
