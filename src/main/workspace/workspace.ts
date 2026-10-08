import { promises as fs, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { shell } from 'electron';
import {
  PushTopic,
  RpcErrorCode,
  type DirEntry,
  type FileContent,
  type FileStat,
  type SearchHit,
  type SearchOptions,
  type SearchResult,
  type WorkspaceInfo,
} from '../../shared/api';
import { RpcFailure } from '../ipc/router';

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.cache', '__pycache__', '.venv', 'release']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_RESULTS = 2000;
/** Сколько файлов читаем параллельно: больше — уже перегрузка диска, меньше — простой. */
const SEARCH_CONCURRENCY = 8;
/** Предохранитель от обхода гигантских деревьев без совпадений. */
const MAX_SCAN_FILES = 20_000;

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
    this.startWatcher(root);

    return { root, name: path.basename(root) || root, entries: await this.readDir(root) };
  }

  close(): void {
    this.stopWatcher();
    this.root = null;
    this.rootReal = null;
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

  async readFile(filePath: string): Promise<FileContent> {
    const file = await this.safePath(filePath);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) throw new RpcFailure(RpcErrorCode.NotFound, `Файл не найден: ${file}`);
    if (stat.size > MAX_FILE_BYTES) {
      throw new RpcFailure(RpcErrorCode.InvalidParams, `Файл больше ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} МБ — открывать такое в редакторе пока нельзя`);
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
    const stat = await fs.stat(file);
    return { mtimeMs: stat.mtimeMs };
  }

  async stat(filePath: string): Promise<FileStat> {
    const file = await this.safePath(filePath);
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
    return file;
  }

  async createDir(dirPath: string): Promise<string> {
    const dir = await this.safePath(dirPath);
    await fs.mkdir(dir, { recursive: true });
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
          if (!IGNORED_DIRS.has(dirent.name)) await collect(full);
          continue;
        }
        if (!dirent.isFile()) continue;
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
          text = await fs.readFile(full, 'utf8');
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
        }
      }
    };

    await Promise.all(Array.from({ length: SEARCH_CONCURRENCY }, () => worker()));

    // Пул завершает файлы в произвольном порядке — для стабильного вывода сортируем.
    hits.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
    return { hits: hits.slice(0, limit), truncated: stop || files.length >= MAX_SCAN_FILES, scanned };
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
  private async safePath(target: string): Promise<string> {
    const root = this.requireRoot();
    const resolved = path.resolve(target);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new RpcFailure(RpcErrorCode.InvalidParams, 'Путь вне рабочей папки');
    }

    const real = await fs.realpath(resolved).catch(() => null);
    if (real && this.rootReal) {
      if (real !== this.rootReal && !real.startsWith(this.rootReal + path.sep)) {
        throw new RpcFailure(RpcErrorCode.InvalidParams, 'Путь вне рабочей папки (симлинк)');
      }
    }
    return resolved;
  }

  private startWatcher(root: string): void {
    try {
      this.watcher = watch(root, { recursive: true }, (_eventType, filename) => {
        const changed = filename ? path.join(root, filename.toString()) : root;
        this.pendingChange = changed;
        if (this.watchTimer) return;
        this.watchTimer = setTimeout(() => {
          this.watchTimer = null;
          const payload = { root, path: this.pendingChange };
          this.pendingChange = null;
          this.onChange(PushTopic.WorkspaceChanged, payload);
        }, 120);
      });
    } catch {
      // не на всех платформах есть рекурсивный watch — живём без автообновления
      this.watcher = null;
    }
  }

  private stopWatcher(): void {
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    this.watcher?.close();
    this.watcher = null;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Минимальная поддержка глоб: `**` — любая глубина, `*` — в пределах сегмента. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/?/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '(?:.*/)?');
  return new RegExp(`^${escaped}$`);
}
