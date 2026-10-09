import type { DirEntry, WorkspaceInfo } from '../../shared/api';
import { Emitter } from './events';
import type { RpcClient } from './rpc';

/**
 * Состояние рабочей папки. Всё общение с ФС идёт через RPC — renderer
 * не знает ни про node:fs, ни про то, локальная это папка или удалённая.
 */
export class WorkspaceModel {
  private info: WorkspaceInfo | null = null;

  private readonly changeEmitter = new Emitter<WorkspaceInfo | null>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly rpc: RpcClient) {}

  get current(): WorkspaceInfo | null {
    return this.info;
  }

  get root(): string | null {
    return this.info?.root ?? null;
  }

  get name(): string {
    return this.info?.name ?? 'нет папки';
  }

  /** Диалог выбора папки + открытие. Возвращает путь или null, если отменили. */
  async pick(): Promise<string | null> {
    const result = await this.rpc.request('dialog.pickFolder', { title: 'Открыть папку проекта' });
    if (!result.path) return null;
    await this.open(result.path);
    return result.path;
  }

  async open(root: string): Promise<WorkspaceInfo> {
    const info = await this.rpc.request('workspace.open', { path: root });
    this.info = info;
    this.changeEmitter.fire(info);
    return info;
  }

  async refresh(): Promise<void> {
    if (!this.info) return;
    await this.open(this.info.root);
  }

  readDir(dir: string): Promise<DirEntry[]> {
    return this.rpc.request('workspace.readDir', { path: dir });
  }

  /** Путь относительно корня — так его показывает статусбар и заголовок вкладки. */
  relative(target: string): string {
    const root = this.root;
    if (!root) return target;
    const relative = relativePath(root, target);
    return relative || this.name;
  }
}

/**
 * `node:path` в renderer нет и быть не должно (изоляция контекста),
 * поэтому путь считается строками.
 *
 * Разделитель берём из самого пути, а не считаем его всегда прямым: main отдаёт
 * пути как есть (`path.join`), и на Windows это обратные слэши. С прежним
 * «всегда /» относительный путь на Windows не находился, и файл выглядел как
 * лежащий вне проекта — ломались хлебные крошки и запуск (он требует путь от корня).
 */
export function relativePath(root: string, target: string): string {
  if (target === root) return '';
  const separator = root.includes('\\') ? '\\' : '/';
  const prefix = root.endsWith(separator) ? root : `${root}${separator}`;
  return target.startsWith(prefix) ? target.slice(prefix.length) : target;
}
