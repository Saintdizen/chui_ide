import path from 'node:path';
import type { DirEntry, FileContent, FileStat, ReplaceFilesOptions, SearchOptions, SearchResult } from '../../shared/api/fs';
import type { DocsQuery, DocsResult } from '../../shared/docs-index';
import type { WorkspaceService } from '../workspace/workspace';
import { RpcFailure } from '../ipc/router';
import { RpcErrorCode } from '../../shared/api/transport';

/**
 * Каталог, в котором работает ОДНА беседа (п.31).
 *
 * Две задачи идут одновременно в разных worktree, но `WorkspaceService` знает
 * только активный корень — один на окно. Инструменты агента зовут
 * `ctx.workspace`, и без этого фасада вторая задача читала бы и ПИСАЛА в файлы
 * первой: относительный путь разрешался бы в чужое дерево.
 *
 * Поэтому: всё, что принимает относительный путь или спрашивает «где корень»,
 * переводится в каталог беседы; а чтение/запись идут через тот же сервис (он
 * держит границу путей и кеш), но АБСОЛЮТНЫМ путём — так `safePath` проверяет
 * именно каталог беседы, а не активный корень.
 */
export class TaskWorkspace {
  constructor(
    private readonly service: WorkspaceService,
    /** Каталог беседы, абсолютный. */
    readonly root: string,
  ) {}

  /** Корень глазами инструментов: свой, а не активный у окна. */
  rootPath(): string {
    return this.root;
  }

  /**
   * Относительный путь разрешается от каталога беседы; абсолютный — проверяется.
   *
   * Своя же граница нужна и здесь: «../other/x.ts» из каталога задачи ведёт в
   * соседний worktree, то есть в файлы ЧУЖОЙ задачи. Это не безопасность — это
   * тот же п.31 с другой стороны: правки одной задачи не должны попадать в другую.
   */
  private full(target: string): string {
    const resolved = path.isAbsolute(target) ? path.resolve(target) : path.resolve(this.root, target);
    const relative = path.relative(this.root, resolved);
    const outside = relative.startsWith('..') || path.isAbsolute(relative);
    if (outside) throw new RpcFailure(RpcErrorCode.InvalidParams, `Путь вне каталога задачи: ${resolved}`);
    return resolved;
  }

  readDir(dirPath: string): Promise<DirEntry[]> {
    return this.service.readDir(this.full(dirPath));
  }

  readFile(filePath: string): Promise<FileContent> {
    return this.service.readFile(this.full(filePath));
  }

  stat(filePath: string): Promise<FileStat> {
    return this.service.stat(this.full(filePath));
  }

  createFile(filePath: string, contents = ''): Promise<string> {
    return this.service.createFile(this.full(filePath), contents);
  }

  rename(from: string, to: string): Promise<string> {
    return this.service.rename(this.full(from), this.full(to));
  }

  trash(target: string, signal?: AbortSignal): Promise<{ undo: string | null }> {
    return this.service.trash(this.full(target), signal);
  }

  /**
   * Замена по файлам: без `paths` сервис обошёл бы активный корень окна —
   * то есть чужое дерево. Явно отдаём свой каталог папкой поиска.
   */
  replace(options: ReplaceFilesOptions): Promise<{ files: string[]; replaced: number }> {
    return this.service.replace(options, this.root);
  }

  /**
   * Поиск: без явной области — по каталогу беседы, а не по активному корню.
   * Область задана — приводим её к своему дереву (как и всё остальное).
   */
  search(options: SearchOptions, signal?: AbortSignal): Promise<SearchResult> {
    return this.service.search({ ...options, path: this.full(options.path ?? '.') }, signal);
  }

  /**
   * Имена файлов: сервис отдаёт их по активному корню окна, поэтому берём с запасом
   * и режем по своему каталогу — иначе вторая задача искала бы в дереве первой.
   */
  /**
   * Имена файлов: сервис фильтрует по активному корню окна, поэтому берём с
   * запасом и оставляем только СВОИ пути — иначе вторая задача увидела бы имена
   * из дерева первой и стала бы править их.
   */
  async findFiles(glob?: string, limit = 200): Promise<string[]> {
    const cap = Math.min(Math.max(limit, 1), 2000);
    const all = await this.service.findFiles(glob, cap * 8, this.root);
    const mine = all.filter((full) => {
      const relative = path.relative(this.root, full);
      return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    });
    return mine.slice(0, cap);
  }

  /** Справка по коду: область идёт вторым доводом — иначе сервис смотрит в активный корень. */
  searchDocs(options: DocsQuery): Promise<DocsResult> {
    return this.service.searchDocs(options, this.root);
  }
}
