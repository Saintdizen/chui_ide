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

  /** Дождаться текущей сборки — нужно проверкам и пробе, человеку не нужно никогда. */
  async settled(): Promise<void> {
    while (this.running) await this.running;
  }

  /**
   * Где объявлено имя: по карте, без сервера и без ожидания. Пока карта собирается,
   * ответ неполный — но он есть, и это лучше пустого списка.
   */
  find(query: string, limit = 50): ProjectSymbol[] {
    return queryIndex(this.files.values(), query, limit);
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
