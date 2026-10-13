import { spawn } from 'node:child_process';
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
import { nextActiveRoot, type WorkspaceRoot } from '../../shared/workspace-roots';
import { RpcFailure } from '../ipc/router';
import { ContentCache, type ContentCacheStats } from './content-cache';
import { escapesRoot, isInsideRoot } from './path-guard';
import { globToRegExp } from '../../shared/glob';
import { parseRipgrepJson, ripgrepArgs } from '../../shared/ripgrep';
import { combineIgnoreFiles, IgnoreRules } from '../../shared/ignore';
import { replaceAll } from '../../shared/replace';
import { MAX_OPEN_BYTES, isReadOnlySize, withinOpenLimit } from '../../shared/large-file';
import { buildFolderDiff, splitFolderLists, type FolderCompareResult } from '../../shared/folder-compare';

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
/** Потолок контекста вокруг совпадения: `-C 5` уже показывает блок целиком. */
const MAX_SEARCH_CONTEXT = 5;
/** Потолок длины строки в выводе поиска: и у совпадения, и у соседних строк. */
const MAX_HIT_LINE_CHARS = 400;
/** Потолок файлов, которые сравниваем по содержимому: остальные сверяем по размеру. */
const MAX_COMPARE_READS = 1000;

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
/**
 * Состояние одного корня рабочей области: сам путь, его realpath, правила исключения
 * и наблюдатель. У каждого корня они свои — правила одного проекта не должны гасить
 * обход другого, а наблюдатель нужен на каждый корень отдельно.
 */
interface RootState {
  root: string;
  /** Канонический путь (после симлинков) — по нему проверяем выход наружу. */
  rootReal: string | null;
  ignore: IgnoreRules;
  watcher: FSWatcher | null;
  watchRetry: NodeJS.Timeout | null;
  watchRetries: number;
}

export class WorkspaceService {
  /**
   * Корни рабочей области: у обычного проекта он один, но их может быть несколько —
   * тогда дерево показывает все, а операции без явного пути идут по активному.
   */
  private roots: RootState[] = [];
  /** Активный корень: им отвечают git, поиск и запуск, когда файл не назван. */
  private active: string | null = null;
  /** Схлопывание потока изменений в одно уведомление — общее для всей области. */
  private watchTimer: NodeJS.Timeout | null = null;
  private pendingChange: string | null = null;
  /**
   * Содержимое прочитанных файлов. Чтение — самая дорогая часть поиска (на дереве
   * в 7,5 тысяч файлов это 788 мс из 875), поэтому повторный поиск читает только
   * изменившееся. Свежесть сверяется по `mtime` и размеру при каждом обращении.
   */
  private readonly contents = new ContentCache();
  /** Есть ли ripgrep в системе: `null` — ещё не выяснили. */
  private ripgrepFound: boolean | null = null;

  constructor(private readonly onChange: (topic: string, payload: unknown) => void) {}

  /** Активный корень — им отвечают операции без явного пути. */
  rootPath(): string | null {
    return this.active;
  }

  /** Все корни рабочей области. */
  rootList(): WorkspaceRoot[] {
    return this.roots.map((state) => ({ root: state.root, name: path.basename(state.root) || state.root }));
  }

  /**
   * Открыть папку КАК ПРОЕКТ: рабочая область заменяется этой одной папкой. Так
   * работает открытие из стартового окна и `chui_iDE ~/проект` — там ожидается
   * именно замена, а не добавление к прошлому.
   */
  async open(rootPath: string): Promise<WorkspaceInfo> {
    const state = await this.makeRoot(rootPath);
    if (!state) throw new RpcFailure(RpcErrorCode.NotFound, `Папка не найдена: ${path.resolve(rootPath)}`);
    this.closeAllRoots();
    this.roots = [state];
    this.active = state.root;
    this.startWatcher(state);
    return this.infoFor(state.root);
  }

  /**
   * Добавить корень в рабочую область (несколько папок в одном окне). Он становится
   * активным: человек только что его выбрал и, скорее всего, будет работать там.
   */
  async addRoot(rootPath: string): Promise<WorkspaceInfo> {
    const state = await this.makeRoot(rootPath);
    if (!state) throw new RpcFailure(RpcErrorCode.NotFound, `Папка не найдена: ${path.resolve(rootPath)}`);
    if (this.roots.some((item) => item.root === state.root)) {
      this.active = state.root;
      return this.infoFor(state.root);
    }
    this.roots = [...this.roots, state];
    this.active = state.root;
    this.startWatcher(state);
    return this.infoFor(state.root);
  }

  /** Убрать корень из области. Активным становится первый оставшийся. */
  async removeRoot(rootPath: string): Promise<WorkspaceInfo | null> {
    const target = path.resolve(rootPath);
    const state = this.roots.find((item) => item.root === target);
    if (!state) return this.active ? this.infoFor(this.active) : null;
    this.stopWatcher(state);
    const next = nextActiveRoot(this.rootList(), target);
    this.roots = this.roots.filter((item) => item.root !== target);
    this.active = next;
    // Содержимое убранного корня держать в памяти незачем — чистим кэш целиком.
    this.contents.clear();
    if (!this.active) return null;
    return this.infoFor(this.active);
  }

  /** Сделать корень активным (клик по нему в дереве или переключение проекта). */
  async setActiveRoot(rootPath: string): Promise<WorkspaceInfo> {
    const target = path.resolve(rootPath);
    if (!this.roots.some((item) => item.root === target)) {
      throw new RpcFailure(RpcErrorCode.NotFound, `Папка не в рабочей области: ${target}`);
    }
    this.active = target;
    return this.infoFor(target);
  }

  close(): void {
    this.closeAllRoots();
    this.roots = [];
    this.active = null;
    // Проект закрыт: держать чужое содержимое в памяти незачем.
    this.contents.clear();
  }

  /** Собрать состояние корня: путь, realpath, правила исключения. `null` — папки нет. */
  private async makeRoot(rootPath: string): Promise<RootState | null> {
    const root = path.resolve(rootPath);
    const stat = await fs.stat(root).catch(() => null);
    if (!stat?.isDirectory()) return null;
    return {
      root,
      rootReal: await fs.realpath(root).catch(() => root),
      ignore: await this.readIgnoreRules(root),
      watcher: null,
      watchRetry: null,
      watchRetries: 0,
    };
  }

  /** Сведения о корне для renderer: он сам, его записи и список всех корней области. */
  private async infoFor(root: string): Promise<WorkspaceInfo> {
    return {
      root,
      name: path.basename(root) || root,
      entries: await this.readDir(root),
      roots: this.rootList(),
    };
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

  /** Исключён ли путь по правилам ТОГО корня, которому он принадлежит. */
  private isIgnored(fullPath: string, isDir: boolean): boolean {
    const owner = this.ownerOf(fullPath);
    if (!owner || owner.ignore.size === 0) return false;
    const relative = path.relative(owner.root, fullPath).split(path.sep).join('/');
    // Пустой относительный путь — это сам корень: его правила не исключают.
    return relative !== '' && owner.ignore.ignores(relative, isDir);
  }

  /** Корень области, вмещающий путь: самый глубокий из подходящих. */
  private ownerOf(target: string): RootState | null {
    const resolved = path.resolve(target);
    let found: RootState | null = null;
    for (const state of this.roots) {
      if (!isInsideRoot(state.root, resolved)) continue;
      if (!found || state.root.length > found.root.length) found = state;
    }
    return found;
  }

  /** Сколько правил исключения прочитано (по активному корню): видно, действует ли файл. */
  ignoreRuleCount(): number {
    return this.ownerOf(this.active ?? '')?.ignore.size ?? 0;
  }

  /** Состояние кэша содержимого: попадания и занятая память. Нужно проверкам. */
  cacheStats(): ContentCacheStats {
    return this.contents.stats();
  }

  /**
   * Перечитать правила исключения. Их правят во время работы — добавил строку в
   * `.ai_ignore`, и поиск должен перестать находить лишнее в том же сеансе.
   */
  private async reloadIgnore(root: string): Promise<void> {
    const state = this.roots.find((item) => item.root === root);
    if (!state) return;
    state.ignore = await this.readIgnoreRules(root);
    this.scheduleChange(root);
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
    if (!withinOpenLimit(stat.size)) {
      throw new RpcFailure(
        RpcErrorCode.InvalidParams,
        `Файл ${Math.round(stat.size / 1024 / 1024)} МБ больше предела ` +
          `${Math.round(MAX_OPEN_BYTES / 1024 / 1024)} МБ — открывать такое в редакторе нельзя`,
      );
    }

    const buffer = await fs.readFile(file);
    // EOL нормализуем к \n: одна модель документа — один формат, иначе позиции правок расходятся
    // между документом, редактором и AI-ассистентом.
    // Большой файл всё же отдаём, но помечаем «только чтение»: посмотреть полезно, править — нет.
    return {
      text: buffer.toString('utf8').replace(/\r\n/g, '\n'),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      readOnly: isReadOnlySize(stat.size),
    };
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

  /**
   * Копия файла или папки в новое место. Существующий объект не перетираем — как и
   * при переименовании: молча затереть чужой файл дороже, чем показать отказ.
   */
  async copy(from: string, to: string): Promise<string> {
    const source = await this.safePath(from);
    const target = await this.safePath(to);
    const existing = await fs.stat(target).catch(() => null);
    if (existing) {
      throw new RpcFailure(RpcErrorCode.InvalidParams, `Уже существует: ${path.basename(target)}`);
    }
    // `force: false` и `errorOnExist` гасят перезапись: копия не должна стирать то,
    // что уже лежит в целевой папке.
    await fs.cp(source, target, { recursive: true, force: false, errorOnExist: true });
    this.contents.invalidate(target);
    this.notifyChanged(target);
    this.notifyChanged(path.dirname(target));
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
    // Область поиска: папка или файл внутри проекта. Путь проходит ту же границу,
    // что и чтение, поэтому искать «где-нибудь снаружи» через search нельзя.
    const scope = options.path ? await this.safePath(options.path) : root;
    const limit = Math.min(options.maxResults ?? 200, MAX_SEARCH_RESULTS);
    const context = options.filesOnly ? 0 : Math.min(Math.max(options.context ?? 0, 0), MAX_SEARCH_CONTEXT);

    // Сперва пробуем ripgrep: он обходит проект потоком и на большом дереве
    // быстрее нашего обхода. Нет его в системе или он не справился — ищем сами:
    // результат у обоих путей один, выбор пути наружу не видён.
    const viaRipgrep = await this.searchWithRipgrep(scope, options, limit, context, signal);
    if (viaRipgrep) return viaRipgrep;

    return this.searchWithFs(scope, options, limit, context, signal);
  }

  /**
   * Поиск через ripgrep. `null` — искать надо своим обходом (нет команды или сбой).
   */
  private async searchWithRipgrep(
    scope: string,
    options: SearchOptions,
    limit: number,
    context: number,
    signal?: AbortSignal,
  ): Promise<SearchResult | null> {
    if (!(await this.hasRipgrep())) return null;
    // Маска и исключения меряются от области поиска — как в собственном обходе.
    // Для файла «областью» становится его каталог, а сам файл — единственным путём.
    const stat = await fs.stat(scope).catch(() => null);
    const cwd = stat?.isFile() ? path.dirname(scope) : scope;
    const target = stat?.isFile() ? path.basename(scope) : '.';
    const args = ripgrepArgs({ ...options, path: target }, [...IGNORED_DIRS], limit, context);

    try {
      const output = await runRipgrep(args, cwd, signal);
      // Команда есть, но совпадений нет — это результат, а не сбой.
      if (output === null) return null;
      return parseRipgrepJson(output, options, limit);
    } catch {
      return null;
    }
  }

  /** Есть ли ripgrep в системе. Спрашиваем один раз и запоминаем ответ. */
  private async hasRipgrep(): Promise<boolean> {
    if (this.ripgrepFound === null) {
      this.ripgrepFound = await new Promise<boolean>((resolve) => {
        const child = spawn('rg', ['--version'], { windowsHide: true });
        child.on('error', () => resolve(false));
        child.on('close', (code) => resolve(code === 0));
      }).catch(() => false);
    }
    return this.ripgrepFound;
  }

  private async searchWithFs(
    scope: string,
    options: SearchOptions,
    limit: number,
    context: number,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
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
        // Маска меряется от области поиска, а не от корня проекта: с `path=src`
        // маска `*.ts` означает «файлы прямо в src», а не «в src на любой глубине».
        if (globMatcher && !globMatcher.test(path.relative(scope, full))) continue;
        files.push(full);
      }
    };

    // Область может быть и одним файлом: тогда просто берём его, а маска
    // проверяется по имени файла — `glob` тут означает «тот самый файл?».
    const scopeStat = await fs.stat(scope).catch(() => null);
    if (scopeStat?.isFile()) {
      if (!globMatcher || globMatcher.test(path.basename(scope))) files.push(scope);
    } else {
      await collect(scope);
    }

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

          const hit: SearchHit = {
            path: full,
            line: lineIndex + 1,
            column: match.index + 1,
            text: line.trim().slice(0, MAX_HIT_LINE_CHARS),
          };
          // Соседние строки отдаём как есть, без trim: отступы в коде значимы, и
          // именно по ним видно, к какому блоку относится совпадение. Потолок
          // длины тот же, что у строки совпадения.
          if (context > 0) {
            hit.before = lines.slice(Math.max(0, lineIndex - context), lineIndex).map(clipLine);
            hit.after = lines.slice(lineIndex + 1, lineIndex + 1 + context).map(clipLine);
          }
          hits.push(hit);
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
   * Сравнить две папки рабочей области: какие файлы различаются.
   *
   * Пути берём относительные: файл только слева — удалён, только справа — добавлен,
   * в обеих — сверяем содержимое. Читаем только те общие файлы, у которых совпал
   * размер, и лишь пока не упёрлись в потолок: сравнение папок не должно тянуть в
   * память весь проект. Общие файлы крупнее порога и хвост сверх потолка считаются
   * совпавшими по размеру — об этом честно говорит флаг `truncated`.
   */
  async compareFolders(left: string, right: string): Promise<FolderCompareResult> {
    const leftDir = await this.safePath(left);
    const rightDir = await this.safePath(right);
    const [leftStat, rightStat] = await Promise.all([
      fs.stat(leftDir).catch(() => null),
      fs.stat(rightDir).catch(() => null),
    ]);
    if (!leftStat?.isDirectory()) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Слева не папка');
    if (!rightStat?.isDirectory()) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Справа не папка');

    const leftList = await this.collectIn(leftDir);
    const rightList = await this.collectIn(rightDir);
    const lists = splitFolderLists(leftList.files, rightList.files);

    const differing = new Set<string>();
    let reads = 0;
    let truncated = leftList.truncated || rightList.truncated;
    for (const relative of lists.common) {
      const leftFile = path.join(leftDir, ...relative.split('/'));
      const rightFile = path.join(rightDir, ...relative.split('/'));
      const [a, b] = await Promise.all([fs.stat(leftFile).catch(() => null), fs.stat(rightFile).catch(() => null)]);
      if (!a || !b) {
        differing.add(relative);
        continue;
      }
      if (a.size !== b.size) {
        differing.add(relative);
        continue;
      }
      // Размер совпал — сравниваем содержимое, но не для огромных и не сверх потолка.
      if (a.size > MAX_FILE_BYTES) continue;
      if (reads >= MAX_COMPARE_READS) {
        truncated = true;
        continue;
      }
      reads += 1;
      const [leftText, rightText] = await Promise.all([
        fs.readFile(leftFile, 'utf8').catch(() => null),
        fs.readFile(rightFile, 'utf8').catch(() => null),
      ]);
      if (leftText === null || rightText === null || leftText !== rightText) differing.add(relative);
    }

    const { files, identical } = buildFolderDiff(lists, (relative) => differing.has(relative));
    return { left: leftDir, right: rightDir, files, identical, truncated };
  }

  /**
   * Файлы папки относительными POSIX-путями. Обход свой, а не общий (`collectFiles`):
   * там точкой отсчёта служит корень проекта, а здесь — любая папка области. Служебные
   * каталоги (`node_modules`, `.git`) пропускаем: в сравнении они только мешают.
   */
  private async collectIn(dir: string): Promise<{ files: string[]; truncated: boolean }> {
    const files: string[] = [];
    let truncated = false;
    const collect = async (current: string): Promise<void> => {
      if (files.length >= MAX_SCAN_FILES) {
        truncated = true;
        return;
      }
      const dirents = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
      for (const dirent of dirents) {
        if (files.length >= MAX_SCAN_FILES) {
          truncated = true;
          return;
        }
        const full = path.join(current, dirent.name);
        if (dirent.isDirectory()) {
          if (!IGNORED_DIRS.has(dirent.name)) await collect(full);
          continue;
        }
        if (dirent.isFile()) files.push(path.relative(dir, full).split(path.sep).join('/'));
      }
    };
    await collect(dir);
    return { files, truncated };
  }

  /**
   * Файлы по glob-маске пути. Обход общий с `listFiles` и `search`, поэтому
   * служебные папки и потолок глубины те же. Возвращаем относительные POSIX-пути:
   * агенту они короче и читаемее абсолютных.
   */
  async findFiles(glob?: string, limit = 200): Promise<string[]> {
    const root = this.requireRoot();
    const matcher = glob?.trim() ? globToRegExp(glob.trim()) : null;
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
    const matcher = options.glob?.trim() ? globToRegExp(options.glob.trim()) : null;
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
    this.closeAllRoots();
  }

  private requireRoot(): string {
    if (!this.active) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Рабочая папка не открыта');
    return this.active;
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
    this.requireRoot();
    const resolved = path.resolve(target);
    const owner = this.ownerOf(resolved);
    if (!owner) {
      throw new RpcFailure(RpcErrorCode.InvalidParams, 'Путь вне рабочей папки');
    }

    if (!options.allowOutsideSymlink) {
      const real = await fs.realpath(resolved).catch(() => null);
      // Симлинк обязан остаться внутри ХОТЯ БЫ ОДНОГО корня области.
      const inside = this.roots.some((state) => !escapesRoot(state.rootReal, real));
      if (!inside) {
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
      const changed = this.pendingChange ?? this.active;
      this.pendingChange = null;
      if (!this.active) return;
      // Уведомление несёт корень, к которому относится правка: дерево перечитывает
      // именно его ветку, а не всю область.
      const owner = changed ? this.ownerOf(changed) : null;
      const payload: WorkspaceChangedPayload = { root: owner?.root ?? this.active, path: changed ?? this.active };
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
    if (!this.active) return;
    this.scheduleChange(target);
  }

  /** Наблюдатель за корнем: у каждого корня он свой — папки независимы. */
  private startWatcher(state: RootState): void {
    const root = state.root;
    try {
      state.watcher = watch(root, { recursive: true }, (_eventType, filename) => {
        const name = filename?.toString();
        // Правила исключения перечитываем сразу: иначе правка `.ai_ignore`
        // подействовала бы только при следующем открытии проекта.
        if (name && IGNORE_FILES.some((file) => file === name)) void this.reloadIgnore(root);
        this.scheduleChange(name ? path.join(root, name) : root);
      });
      state.watchRetries = 0;
      // Ошибку наблюдения (переполнение буфера inotify, сетевой диск) не роняем
      // в консоль: без наблюдения чужую правку не увидим, но свои изменения
      // продолжаем сообщать сами. Пробуем поднять наблюдение заново — иначе
      // после первой же ошибки дерево и git-пометки застыли бы до перезапуска IDE.
      state.watcher.on('error', () => {
        state.watcher?.close();
        state.watcher = null;
        this.scheduleWatchRetry(state);
      });
    } catch {
      // не на всех платформах есть рекурсивный watch — пробуем ещё раз позже
      state.watcher = null;
      this.scheduleWatchRetry(state);
    }
  }

  /**
   * Перезапуск наблюдения после сбоя. Пробуем несколько раз с паузой: сбой обычно
   * временный (переполнение inotify от пачки правок), и наблюдение поднимается
   * само. Если же платформа не умеет рекурсивный watch вовсе, после нескольких
   * попыток перестаём повторять, чтобы не крутить пустой таймер.
   */
  private scheduleWatchRetry(state: RootState): void {
    if (state.watchRetry || state.watchRetries >= WATCH_RETRY_LIMIT) return;
    state.watchRetries += 1;
    state.watchRetry = setTimeout(() => {
      state.watchRetry = null;
      if (this.roots.includes(state) && !state.watcher) this.startWatcher(state);
    }, WATCH_RETRY_MS);
  }

  /** Снять наблюдение одного корня. */
  private stopWatcher(state: RootState): void {
    if (state.watchRetry) {
      clearTimeout(state.watchRetry);
      state.watchRetry = null;
    }
    state.watchRetries = 0;
    state.watcher?.close();
    state.watcher = null;
  }

  /** Снять наблюдение со всех корней и погасить отложенные уведомления. */
  private closeAllRoots(): void {
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    this.pendingChange = null;
    for (const state of this.roots) this.stopWatcher(state);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Строка контекста в вывод поиска. Отступы сохраняем (в коде они значимы), но
 * длину ограничиваем тем же потолком, что и у строки совпадения: файл, где одна
 * строка занимает килобайты, не должен раздувать ответ инструмента.
 */
function clipLine(line: string): string {
  const withoutCarriage = line.endsWith('\r') ? line.slice(0, -1) : line;
  return withoutCarriage.length > MAX_HIT_LINE_CHARS
    ? `${withoutCarriage.slice(0, MAX_HIT_LINE_CHARS)}…`
    : withoutCarriage;
}

/**
 * Запустить ripgrep и собрать вывод. `null` — совпадений нет или команду прервали;
 * сбой запуска летит исключением, чтобы вызывающий откатился на свой обход.
 */
function runRipgrep(args: readonly string[], cwd: string, signal?: AbortSignal): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const child = spawn('rg', [...args], { cwd, windowsHide: true });
    // Вывод собираем целиком: он ограничен числом совпадений, а склеивать
    // поток частями пришлось бы всё равно — запись рвётся посредине.
    let out = '';
    let failed = '';

    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      failed += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      // 0 — есть совпадения, 1 — их нет (это не ошибка), 2 — сбой самого поиска.
      if (code === 0) resolve(out);
      else if (code === 1) resolve(null);
      else reject(new Error(`rg завершился с кодом ${code}: ${failed.trim()}`));
    });

    const abort = (): void => {
      child.kill();
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.on('close', () => signal?.removeEventListener('abort', abort));
  });
}
