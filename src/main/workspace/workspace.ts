import { promises as fs, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { shell } from 'electron';
import {
  PushTopic,
  RpcErrorCode,
  type DirEntry,
  type FileContent,
  type FileStat,
  type ReplaceFilesOptions,
  type SearchHit,
  type SearchOptions,
  type SearchResult,
  type WorkspaceChangedPayload,
  type WorkspaceInfo,
} from '../../shared/api';
import { RpcFailure } from '../ipc/router';
import { ContentCache, type ContentCacheStats } from './content-cache';
import { escapesRoot, isInsideRoot } from './path-guard';
import { globToRegExp } from '../../shared/glob';
import { combineIgnoreFiles, IgnoreRules } from '../../shared/ignore';
import { replaceAll } from '../../shared/replace';

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.cache', '__pycache__', '.venv', 'release']);

/**
 * Файлы исключений в корне проекта. `.gitignore` читаем тоже: проект уже сказал
 * им, что не является его частью, и искать в собранном или сгенерированном —
 * значит получать совпадения из мусора. `.ai_ignore` читается последним, поэтому
 * его `!` может вернуть обратно то, что исключил git.
 *
 * Вложенные файлы правил не читаем: обход пришлось бы вести со стеком правил на
 * каждую папку. Для корня этого хватает почти всегда, а лишнюю сложность без
 * нужды в обход не тащим.
 */
const IGNORE_FILES = ['.gitignore', '.ai_ignore'] as const;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_RESULTS = 2000;
/** Сколько файлов читаем параллельно: больше — уже перегрузка диска, меньше — простой. */
const SEARCH_CONCURRENCY = 8;
/** Предохранитель от обхода гигантских деревьев без совпадений. */
const MAX_SCAN_FILES = 20_000;
/** Пауза перед повторной попыткой поднять наблюдение за файлами. */
const WATCH_RETRY_MS = 3_000;
/** Сколько раз подряд пробуем поднять наблюдение, прежде чем оставить попытки. */
const WATCH_RETRY_LIMIT = 5;

/**
 * Работа с рабочей директорией. Renderer никогда не трогает ФС напрямую:
 * он видит только этот API, поэтому позже сюда можно подставить виртуальную,
 * удалённую или песочную файловую систему, не меняя UI.
 */
export class WorkspaceService {
  private root: string | null = null;
  private rootReal: string | null = null;
  private watcher: FSWatcher | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private pendingChange: string | null = null;
  /** Отложенный перезапуск наблюдения после сбоя (см. `scheduleWatchRetry`). */
  private watchRetry: NodeJS.Timeout | null = null;
  /** Сдаёмся после стольких подряд неудачных попыток поднять наблюдение. */
  private watchRetries = 0;
  /** Правила исключения обхода: `.gitignore` и `.ai_ignore` из корня проекта. */
  private ignore: IgnoreRules = IgnoreRules.empty();
  /**
   * Содержимое прочитанных файлов. Чтение — самая дорогая часть поиска (на дереве
   * в 7,5 тысяч файлов это 788 мс из 875), поэтому повторный поиск читает только
   * изменившееся. Свежесть сверяется по `mtime` и размеру при каждом обращении.
   */
  private readonly contents = new ContentCache();

  constructor(private readonly onChange: (topic: string, payload: unknown) => void) {}

  rootPath(): string | null {
    return this.root;
  }

  async open(rootPath: string): Promise<WorkspaceInfo> {
    const root = path.resolve(rootPath);
    const stat = await fs.stat(root).catch(() => null);
    if (!stat?.isDirectory()) {
      throw new RpcFailure(RpcErrorCode.NotFound, `Папка не найдена: ${root}`);
    }

    this.stopWatcher();
    this.root = root;
    this.rootReal = await fs.realpath(root).catch(() => root);
    this.ignore = await this.readIgnoreRules(root);
    this.startWatcher(root);

    return { root, name: path.basename(root) || root, entries: await this.readDir(root) };
  }

  close(): void {
    this.stopWatcher();
    this.root = null;
    this.rootReal = null;
    this.ignore = IgnoreRules.empty();
    // Проект закрыт: держать чужое содержимое в памяти незачем.
    this.contents.clear();
  }

  /**
   * Прочитать правила исключения из корня. Файла нет — это нормально: правил
   * просто не будет. Читаем до `MAX_FILE_BYTES`: файл правил такого размера уже
   * не правила, а недоразумение, и разбирать его целиком незачем.
   */
  private async readIgnoreRules(root: string): Promise<IgnoreRules> {
    const files: string[] = [];
    for (const name of IGNORE_FILES) {
      const text = await fs.readFile(path.join(root, name), 'utf8').catch(() => null);
      if (text !== null && text.length <= MAX_FILE_BYTES) files.push(text);
    }
    return files.length > 0 ? combineIgnoreFiles(files) : IgnoreRules.empty();
  }

  /** Исключён ли путь по правилам проекта. Путь — относительно корня. */
  private isIgnored(fullPath: string, isDir: boolean): boolean {
    if (this.ignore.size === 0 || !this.root) return false;
    const relative = path.relative(this.root, fullPath).split(path.sep).join('/');
    // Пустой относительный путь — это сам корень: его правила не исключают.
    return relative !== '' && this.ignore.ignores(relative, isDir);
  }

  /** Сколько правил исключения прочитано: по этому видно, действует ли файл. */
  ignoreRuleCount(): number {
    return this.ignore.size;
  }

  /** Состояние кэша содержимого: попадания и занятая память. Нужно проверкам. */
  cacheStats(): ContentCacheStats {
    return this.contents.stats();
  }

  /**
   * Перечитать правила исключения. Их правят во время работы — добавил строку в
   * `.ai_ignore`, и поиск должен перестать находить лишнее в том же сеансе.
   */
  private async reloadIgnore(): Promise<void> {
    if (!this.root) return;
    this.ignore = await this.readIgnoreRules(this.root);
    this.scheduleChange(this.root);
  }

  async readDir(dirPath: string): Promise<DirEntry[]> {
    const dir = await this.safePath(dirPath);
    const dirents = await fs.readdir(dir, { withFileTypes: true }).catch(() => {
      throw new RpcFailure(RpcErrorCode.NotFound, `Не удалось прочитать папку: ${dir}`);
    });

    const entries = await Promise.all(
      dirents.map(async (dirent): Promise<DirEntry | null> => {
        const kind = dirent.isDirectory() ? 'directory' : dirent.isSymbolicLink() ? 'symlink' : 'file';
        if (kind === 'directory' && IGNORED_DIRS.has(dirent.name)) return null;

        const full = path.join(dir, dirent.name);
        let size = 0;
        try {
          size = (await fs.stat(full)).size;
        } catch {
          // битый симлинк — размер просто неизвестен
        }
        return { name: dirent.name, path: full, kind, size };
      }),
    );

    return entries
      .filter((entry): entry is DirEntry => entry !== null)
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1));
  }

  /**
   * Чтение для редактора. Кэш содержимого здесь нарочно не используется: поиск
   * держит текст как он есть, а сюда он обязан прийти с нормализованными EOL —
   * подмена одного другим сдвинула бы позиции правок.
   */
  async readFile(filePath: string): Promise<FileContent> {
    const file = await this.safePath(filePath);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) throw new RpcFailure(RpcErrorCode.NotFound, `Файл не найден: ${file}`);
    if (stat.size > MAX_FILE_BYTES) {
      throw new RpcFailure(
        RpcErrorCode.InvalidParams,
        `Файл больше ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} МБ — открывать такое в редакторе пока нельзя`,
      );
    }

    const buffer = await fs.readFile(file);
    // EOL нормализуем к \n: одна модель документа — один формат, иначе позиции правок расходятся
    // между документом, Monaco и AI-ассистентом.
    return { text: buffer.toString('utf8').replace(/\r\n/g, '\n'), mtimeMs: stat.mtimeMs };
  }

  async writeFile(filePath: string, text: string): Promise<{ mtimeMs: number }> {
    const file = await this.safePath(filePath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, 'utf8');
    // Свою правку забываем сразу: ждать, пока `mtime` перестанет совпадать,
    // нельзя — у быстрой записи он может остаться тем же, и поиск нашёл бы
    // текст, которого в файле уже нет.
    this.contents.invalidate(file);
    const stat = await fs.stat(file);
    this.notifyChanged(file);
    return { mtimeMs: stat.mtimeMs };
  }

  async stat(filePath: string): Promise<FileStat> {
    // Метаданные — единственное, что читаем, поэтому симлинк наружу не запрещаем:
    // так устроены виртуальные окружения (`.venv/bin/python` ссылается на системный
    // интерпретатор), и по этой проверке IDE решает, каким питоном запускать код.
    const file = await this.safePath(filePath, { allowOutsideSymlink: true });
    const stat = await fs.stat(file).catch(() => null);
    if (!stat) throw new RpcFailure(RpcErrorCode.NotFound, `Путь не найден: ${file}`);
    const kind = stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'file';
    return { path: file, kind, size: stat.size, mtimeMs: stat.mtimeMs };
  }

  /** Создаёт файл: существующий не перетираем, а честно говорим об этом. */
  async createFile(filePath: string, contents = ''): Promise<string> {
    const file = await this.safePath(filePath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    try {
      await fs.writeFile(file, contents, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        throw new RpcFailure(RpcErrorCode.InvalidParams, `Уже существует: ${path.basename(file)}`);
      }
      throw error;
    }
    this.contents.invalidate(file);
    this.notifyChanged(file);
    return file;
  }

  async createDir(dirPath: string): Promise<string> {
    const dir = await this.safePath(dirPath);
    await fs.mkdir(dir, { recursive: true });
    this.notifyChanged(dir);
    return dir;
  }

  async rename(from: string, to: string): Promise<string> {
    const source = await this.safePath(from);
    const target = await this.safePath(to);
    const existing = await fs.stat(target).catch(() => null);
    if (existing) {
      throw new RpcFailure(RpcErrorCode.InvalidParams, `Уже существует: ${path.basename(target)}`);
    }
    await fs.rename(source, target);
    // Содержимое переехало: под старым путём его больше нет, под новым — то же
    // самое, но с другим `mtime`; проще забыть оба.
    this.contents.invalidate(source);
    this.contents.invalidate(target);
    // Старое имя тоже исчезло с диска — дерево должно убрать и его.
    this.notifyChanged(source);
    this.notifyChanged(target);
    return target;
  }

  /** Удаление только в корзину: безвозвратное rm из IDE — слишком дорогая ошибка. */
  async trash(target: string): Promise<void> {
    const resolved = await this.safePath(target);
    if (resolved === this.requireRoot()) {
      throw new RpcFailure(RpcErrorCode.InvalidParams, 'Корень проекта удалить нельзя');
    }
    try {
      await shell.trashItem(resolved);
    } catch (error) {
      throw new RpcFailure(
        RpcErrorCode.Internal,
        `Не удалось переместить в корзину: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.contents.invalidate(resolved);
    this.notifyChanged(resolved);
  }

  async search(options: SearchOptions, signal?: AbortSignal): Promise<SearchResult> {
    const root = this.requireRoot();
    const limit = Math.min(options.maxResults ?? 200, MAX_SEARCH_RESULTS);
    const flags = options.caseSensitive ? 'g' : 'gi';
    const pattern = options.isRegex ? options.query : escapeRegExp(options.query);
    const matcher = new RegExp(pattern, flags);
    const globMatcher = options.glob ? globToRegExp(options.glob) : null;

    // Сначала дешёвый обход: собрать список файлов. Чтение — тяжёлое, поэтому
    // его распараллеливаем с ограничением, а не идём по дереву последовательно.
    const files: string[] = [];
    const collect = async (dir: string): Promise<void> => {
      if (signal?.aborted || files.length >= MAX_SCAN_FILES) return;
      const dirents = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const dirent of dirents) {
        if (signal?.aborted || files.length >= MAX_SCAN_FILES) return;
        const full = path.join(dir, dirent.name);
        if (dirent.isDirectory()) {
          if (!IGNORED_DIRS.has(dirent.name) && !this.isIgnored(full, true)) await collect(full);
          continue;
        }
        if (!dirent.isFile()) continue;
        if (this.isIgnored(full, false)) continue;
        if (globMatcher && !globMatcher.test(path.relative(root, full))) continue;
        files.push(full);
      }
    };
    await collect(root);

    const hits: SearchHit[] = [];
    let scanned = 0;
    let stop = false;
    let next = 0;

    // Пул воркеров: каждый берёт следующий файл, пока список не кончится
    // или не упрёмся в лимит совпадений/отмену.
    const worker = async (): Promise<void> => {
      while (!stop && !signal?.aborted) {
        const index = next;
        next += 1;
        if (index >= files.length) return;
        const full = files[index]!;
        scanned += 1;

        let text: string;
        try {
          const stat = await fs.stat(full);
          if (stat.size > MAX_FILE_BYTES) continue;

          // Кэш проверяем по mtime и размеру: неизменившийся файл не перечитываем.
          // `stat` в десять раз дешевле чтения, поэтому сверка себя оправдывает.
          const cached = this.contents.get(full, stat.mtimeMs, stat.size);
          if (cached !== null) {
            text = cached;
          } else {
            text = await fs.readFile(full, 'utf8');
            // Бинарный файл в кэш не кладём: толку от него нет.
            if (!text.includes('\u0000')) this.contents.set(full, stat.mtimeMs, stat.size, text);
          }
        } catch {
          continue;
        }
        if (text.includes('\u0000')) continue; // бинарный файл

        const lines = text.split('\n');
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          const line = lines[lineIndex]!;
          matcher.lastIndex = 0;
          const match = matcher.exec(line);
          if (!match) continue;

          hits.push({
            path: full,
            line: lineIndex + 1,
            column: match.index + 1,
            text: line.trim().slice(0, 400),
          });
          if (hits.length >= limit) {
            stop = true;
            return;
          }
          // filesOnly — сводка «где встречается»: хватит одного совпадения на файл.
          if (options.filesOnly) break;
        }
      }
    };

    await Promise.all(Array.from({ length: SEARCH_CONCURRENCY }, () => worker()));

    // Пул завершает файлы в произвольном порядке — для стабильного вывода сортируем.
    hits.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
    return { hits: hits.slice(0, limit), truncated: stop || files.length >= MAX_SCAN_FILES, scanned };
  }

  /**
   * Все файлы проекта абсолютными путями. Служебные папки пропускаем, глубину
   * ограничиваем потолком, чтобы огромный репозиторий не вешал main. Общий обход
   * для быстрого открывателя и замены по проекту.
   */
  private async collectFiles(): Promise<string[]> {
    const root = this.requireRoot();
    const files: string[] = [];

    const collect = async (dir: string): Promise<void> => {
      if (files.length >= MAX_SCAN_FILES) return;
      const dirents = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const dirent of dirents) {
        if (files.length >= MAX_SCAN_FILES) return;
        const full = path.join(dir, dirent.name);
        if (dirent.isDirectory()) {
          if (!IGNORED_DIRS.has(dirent.name) && !this.isIgnored(full, true)) await collect(full);
          continue;
        }
        if (dirent.isFile() && !this.isIgnored(full, false)) files.push(full);
      }
    };

    await collect(root);
    return files;
  }

  /**
   * Все файлы проекта — относительными путями (POSIX): из них собирается
   * быстрый открыватель (`Ctrl+Shift+O`). Пути сортируем: список показывается
   * человеку, порядок должен быть стабильным.
   */
  async listFiles(): Promise<string[]> {
    const root = this.requireRoot();
    const files = await this.collectFiles();
    return files
      .map((full) => path.relative(root, full).split(path.sep).join('/'))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  /**
   * Файлы по glob-маске пути. Обход общий с `listFiles` и `search`, поэтому
   * служебные папки и потолок глубины те же. Возвращаем относительные POSIX-пути:
   * агенту они короче и читаемее абсолютных.
   */
  async findFiles(glob?: string, limit = 200): Promise<string[]> {
    const root = this.requireRoot();
    const matcher = glob && glob.trim() ? globToRegExp(glob.trim()) : null;
    const cap = Math.min(Math.max(limit, 1), 2000);

    const files = await this.collectFiles();
    const out: string[] = [];
    for (const full of files) {
      const relative = path.relative(root, full).split(path.sep).join('/');
      if (matcher && !matcher.test(relative)) continue;
      out.push(relative);
      if (out.length >= cap) break;
    }
    out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return out;
  }

  /**
   * Поиск с заменой по всему проекту. Идём по тем же файлам, что и поиск,
   * и пишем только те, где что-то реально изменилось. Возвращаем изменённые
   * пути: renderer обновляет по ним открытые вкладки.
   *
   * Большие файлы пропускаем: держать их целиком в памяти ради замены не стоит.
   */
  async replace(options: ReplaceFilesOptions): Promise<{ files: string[]; replaced: number }> {
    const root = this.requireRoot();
    const targets = await this.collectFiles();
    const matcher = options.glob && options.glob.trim() ? globToRegExp(options.glob.trim()) : null;
    const changed: string[] = [];
    let replaced = 0;

    for (const file of targets) {
      // Маска проверяется по относительному пути: агенту он ближе, чем абсолютный.
      if (matcher && !matcher.test(path.relative(root, file).split(path.sep).join('/'))) continue;
      const stat = await fs.stat(file).catch(() => null);
      if (!stat || stat.size > MAX_FILE_BYTES) continue;

      const buffer = await fs.readFile(file).catch(() => null);
      if (!buffer) continue;
      const text = buffer.toString('utf8').replace(/\r\n/g, '\n');

      const result = replaceAll(text, options.query, options.replacement, {
        isRegex: options.isRegex,
        caseSensitive: options.caseSensitive,
      });
      if (result.count === 0) continue;

      await fs.writeFile(file, result.text, 'utf8');
      this.contents.invalidate(file);
      this.notifyChanged(file);
      changed.push(file);
      replaced += result.count;
    }

    return { files: changed, replaced };
  }

  dispose(): void {
    this.stopWatcher();
  }

  private requireRoot(): string {
    if (!this.root) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Рабочая папка не открыта');
    return this.root;
  }

  /**
   * Защита от выхода за пределы рабочей папки: сначала по нормализованному пути,
   * затем по realpath (симлинк внутри проекта может вести куда угодно).
   */
  /**
   * Проверка пути на безопасность. Лексически он обязан лежать в проекте — это
   * защищает от `..` в запросе.
   *
   * Симлинк внутри проекта может вести наружу, и для операций с содержимым это
   * запрет: иначе через ссылку можно было бы читать и писать чужие файлы. Но
   * `allowOutsideSymlink` снимает запрет там, где наружу уходит лишь чтение
   * метаданных (см. `stat`): виртуальные окружения устроены именно так.
   */
  private async safePath(target: string, options: { allowOutsideSymlink?: boolean } = {}): Promise<string> {
    const root = this.requireRoot();
    const resolved = path.resolve(target);
    if (!isInsideRoot(root, resolved)) {
      throw new RpcFailure(RpcErrorCode.InvalidParams, 'Путь вне рабочей папки');
    }

    if (!options.allowOutsideSymlink) {
      const real = await fs.realpath(resolved).catch(() => null);
      if (escapesRoot(this.rootReal, real)) {
        throw new RpcFailure(RpcErrorCode.InvalidParams, 'Путь вне рабочей папки (симлинк)');
      }
    }
    return resolved;
  }

  /**
   * Сообщить об изменении дерева. Один путь с задержкой: поток событий схлопывается
   * в одно уведомление, а дерево перечитывается один раз, как бы часто ни писали.
   */
  private scheduleChange(changedPath: string): void {
    this.pendingChange = changedPath;
    if (this.watchTimer) return;
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      const path = this.pendingChange ?? this.root;
      this.pendingChange = null;
      if (!this.root) return;
      const payload: WorkspaceChangedPayload = { root: this.root, path: path ?? this.root };
      this.onChange(PushTopic.WorkspaceChanged, payload);
    }, 120);
  }

  /**
   * Уведомление о нашей собственной правке диска. Полагаться только на `fs.watch`
   * нельзя: на части платформ и ФС рекурсивное наблюдение молчит (сетевые диски,
   * лимиты inotify), а тогда агент пишет файл, editor его показывает, а проводник
   * остаётся старым. Поэтому о своих изменениях сообщаем явно, наблюдатель же
   * отвечает за чужие — правки внешним инструментом или в терминале.
   */
  private notifyChanged(target: string): void {
    if (!this.root) return;
    this.scheduleChange(target);
  }

  private startWatcher(root: string): void {
    try {
      this.watcher = watch(root, { recursive: true }, (_eventType, filename) => {
        const name = filename?.toString();
        // Правила исключения перечитываем сразу: иначе правка `.ai_ignore`
        // подействовала бы только при следующем открытии проекта.
        if (name && IGNORE_FILES.some((file) => file === name)) void this.reloadIgnore();
        this.scheduleChange(name ? path.join(root, name) : root);
      });
      this.watchRetries = 0;
      // Ошибку наблюдения (переполнение буфера inotify, сетевой диск) не роняем
      // в консоль: без наблюдения чужую правку не увидим, но свои изменения
      // продолжаем сообщать сами. Пробуем поднять наблюдение заново — иначе
      // после первой же ошибки дерево и git-пометки застыли бы до перезапуска IDE.
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = null;
        this.scheduleWatchRetry();
      });
    } catch {
      // не на всех платформах есть рекурсивный watch — пробуем ещё раз позже
      this.watcher = null;
      this.scheduleWatchRetry();
    }
  }

  /**
   * Перезапуск наблюдения после сбоя. Пробуем несколько раз с паузой: сбой обычно
   * временный (переполнение inotify от пачки правок), и наблюдение поднимается
   * само. Если же платформа не умеет рекурсивный watch вовсе, после нескольких
   * попыток перестаём повторять, чтобы не крутить пустой таймер.
   */
  private scheduleWatchRetry(): void {
    if (this.watchRetry || !this.root || this.watchRetries >= WATCH_RETRY_LIMIT) return;
    this.watchRetries += 1;
    this.watchRetry = setTimeout(() => {
      this.watchRetry = null;
      if (this.root && !this.watcher) this.startWatcher(this.root);
    }, WATCH_RETRY_MS);
  }

  private stopWatcher(): void {
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    if (this.watchRetry) {
      clearTimeout(this.watchRetry);
      this.watchRetry = null;
    }
    this.watchRetries = 0;
    this.pendingChange = null;
    this.watcher?.close();
    this.watcher = null;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
