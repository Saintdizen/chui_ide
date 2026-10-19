import { promises as fs } from 'node:fs';
import path from 'node:path';
import { languageInfoForPath } from '../../shared/languages';
import type { FileSymbol, ProjectSymbol } from '../../shared/lsp-symbols';
import { findEntryPoints, isTestFile } from '../../shared/project-scan';
import {
  basesByLine,
  inheritedFor,
  isIndexedLanguage,
  queryIndex,
  toIndexDecls,
  type IndexedFile,
  type InheritedResult,
  type SymbolIndexStatus,
} from '../../shared/symbol-index';
import { listProjectFiles } from '../project/scan';
import { findDependencyRoots, listDependencyFiles } from './dependencies';
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

/** Сколько файлов зависимостей разбираем за один прогон: проект важнее чужих пакетов. */
const MAX_DEPENDENCY_PARSE_PER_RUN = 600;

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
  /**
   * Окружение Python проекта: интерпретатор и каталог окружения. Окружение бывает и вне
   * проекта (общее в `~/.venvs`), поэтому путь нужен отдельно, а не выводится из корня.
   */
  python?: () => { venvDir: string | null };
  /**
   * Каталоги зависимостей (пакеты `node_modules`, `site-packages`). Рабочая папка по ним
   * разрешает чтение: без этого щелчок по символу из пакета упирался бы в «путь вне
   * рабочей папки» — в том числе у окружения, лежащего вне проекта.
   */
  onDependencyDirs?: (dirs: readonly string[]) => void;
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

  /** Что карта знает сейчас: проект и зависимости считаются отдельно. */
  status(): SymbolIndexStatus {
    let decls = 0;
    let dependencyFiles = 0;
    const packages = new Set<string>();
    for (const file of this.files.values()) {
      decls += file.decls.length;
      if (file.origin !== 'dependency') continue;
      dependencyFiles += 1;
      if (file.package) packages.add(file.package);
    }
    return {
      root: this.root,
      phase: this.phase,
      files: this.files.size,
      decls,
      dependencyFiles,
      dependencyPackages: packages.size,
      skipped: this.skipped,
    };
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
    const symbols = queryIndex(this.files.values(), query, limit);
    const root = this.root;
    if (!root) return symbols;
    // Код проекта хранится относительно корня, зависимость — абсолютным путём: по нему
    // открывается файл, и для чужого пакета вне проекта другого пути нет.
    return symbols.map((symbol) =>
      path.isAbsolute(symbol.path) ? symbol : { ...symbol, path: path.join(root, ...symbol.path.split('/')) },
    );
  }

  /**
   * Что тип умеет и от кого это унаследовано — по карте, без сервера.
   *
   * Иерархию типов умеет и сервер, но только для символа под курсором открытого файла
   * и только у части серверов. Карта отвечает на тот же вопрос по всему проекту сразу
   * и мгновенно: имя взято из текста, а не из позиции в открытом документе.
   */
  inherited(name: string): InheritedResult {
    const result = inheritedFor(this.files.values(), name, this.phase);
    const root = this.root;
    if (!root) return result;
    // Абсолютные пути, как и у поиска: по ним открывается файл (см. `find`).
    const absolute = (target: string): string =>
      path.isAbsolute(target) ? target : path.join(root, ...target.split('/'));
    return {
      ...result,
      declared: result.declared ? { ...result.declared, path: absolute(result.declared.path) } : null,
      members: result.members.map((member) => ({ ...member, path: absolute(member.path) })),
    };
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

    // Отпечатка «размер + время» тут нет намеренно: сюда приходят только те файлы, о
    // правке которых сказали прямо (`noteChanged`). Гадать по отпечатку нельзя: у
    // сохранения того же размера (`Old` → `New`) размер тот же, а время в миллисекундах
    // может совпасть — и на быстрой машине, и всегда на файловой системе с грубым
    // временем. Тогда правка терялась бы молча: карта продолжала бы отдавать старое
    // имя. Лишний разбор на шум наблюдателя дешевле потерянного объявления.
    const known = this.files.get(relative);
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
      // Правленый файл мог быть и чужим: `node_modules` лежит внутри проекта, и
      // наблюдатель за корнем сообщает о правках в нём так же. Признак берём из старой
      // записи — иначе пакет стал бы «кодом проекта» и поднялся бы в выдаче.
      origin: known?.origin ?? 'project',
      package: known?.package ?? null,
      size: stat.size,
      mtime: Math.floor(stat.mtimeMs),
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
        origin: 'project',
        package: null,
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

    // Зависимости — вторым заходом: проект уже в карте, и если обход прервётся здесь,
    // потеряются только чужие объявления, а не свои.
    const dependencies = await this.dependencyPass(root, cached, next);
    skipped += dependencies.skipped;

    this.files = next;
    this.skipped = skipped;
    this.phase = 'ready';
    await this.deps.store.save(root, [...next.values()]);
  }

  /**
   * Обход зависимостей: пакеты `node_modules` и `site-packages` окружения Python.
   *
   * Границы заданы в `dependencies.ts` — файлов на пакет и всего; здесь только разбор.
   * Зависимости кэшируются по абсолютному пути: они лежат и вне проекта, а обновляются
   * реже своего кода (`npm install`), поэтому второй прогон читает их с диска кэша.
   */
  private async dependencyPass(
    root: string,
    cached: Map<string, IndexedFile>,
    next: Map<string, IndexedFile>,
  ): Promise<{ skipped: number }> {
    const roots = await findDependencyRoots({ root, venvDir: this.deps.python?.().venvDir ?? null });
    // Чужой файл должен открываться по щелчку в списке символов — даже если окружение
    // лежит вне проекта. Рабочей папке говорим, где такие каталоги: чтение по ним
    // разрешается, запись — нет.
    this.deps.onDependencyDirs?.(roots.map((entry) => entry.dir));

    let skipped = 0;
    let parsed = 0;
    for (const file of await listDependencyFiles(roots)) {
      if (this.deps.root() !== root) return { skipped };
      const stat = await fs.stat(file.path).catch(() => null);
      if (!stat?.isFile()) continue;

      const mtime = Math.floor(stat.mtimeMs);
      const known = cached.get(file.path);
      if (known && known.size === stat.size && known.mtime === mtime) {
        next.set(file.path, known);
        continue;
      }
      // Бюджет зависимостей свой и скромный: свои объявления нужнее чужих.
      if (parsed >= MAX_DEPENDENCY_PARSE_PER_RUN) {
        if (known) next.set(file.path, known);
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) {
        skipped += 1;
        continue;
      }

      const text = await fs.readFile(file.path, 'utf8').catch(() => null);
      if (text === null) continue;
      parsed += 1;

      const symbols = await this.deps.outline(file.path, file.language, text).catch(() => null);
      if (symbols === null) {
        skipped += 1;
        continue;
      }

      const bases = basesByLine(text, file.language);
      next.set(file.path, {
        path: file.path,
        language: file.language,
        origin: 'dependency',
        package: file.package,
        size: stat.size,
        mtime,
        decls: toIndexDecls(symbols, (line) => bases.get(line) ?? []),
      });
    }

    return { skipped };
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
