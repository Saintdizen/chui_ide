import type { DirEntry, WorkspaceInfo } from '../../shared/api';
import { pathAfter } from '../../shared/paths';
import { relativeToRoots, rootForPath, workspaceLabel, type WorkspaceRoot } from '../../shared/workspace-roots';
import { Emitter } from './events';
import type { RpcClient } from './rpc';

/**
 * Состояние рабочей области. Всё общение с ФС идёт через RPC — renderer
 * не знает ни про `node:fs`, ни про то, локальная это папка или удалённая.
 *
 * Корней может быть несколько: обычный проект — один, но бывает и несколько папок
 * в одном окне (см. `shared/workspace-roots.ts`). Дерево показывает их все, а
 * операции без явного файла (git, поиск, запуск) идут по АКТИВНОМУ корню — `root`.
 */
/**
 * Почему изменилась область. `project` — сменился проект (открыли другую папку или
 * закрыли): рабочее место другое, вкладки и сессию надо перезагрузить. `roots` —
 * в области прибавилась или убралась папка либо сменился активный корень: тот же
 * проект, но работаем в другой папке; вкладки закрывать нельзя.
 */
export type WorkspaceChangeReason = 'project' | 'roots';

export interface WorkspaceChange {
  info: WorkspaceInfo | null;
  reason: WorkspaceChangeReason;
}

export class WorkspaceModel {
  private info: WorkspaceInfo | null = null;

  private readonly changeEmitter = new Emitter<WorkspaceChange>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly rpc: RpcClient) {}

  get current(): WorkspaceInfo | null {
    return this.info;
  }

  /** Активный корень: им отвечают операции без явного пути. */
  get root(): string | null {
    return this.info?.root ?? null;
  }

  /** Все корни рабочей области. */
  get roots(): WorkspaceRoot[] {
    return this.info?.roots ?? [];
  }

  /** Несколько корней? Тогда дерево показывает их верхним уровнем. */
  get isMultiRoot(): boolean {
    return this.roots.length > 1;
  }

  get name(): string {
    return this.info ? this.info.name : 'нет папки';
  }

  /** Подпись области: имя одинокого корня или «N папки». */
  get label(): string {
    return workspaceLabel(this.roots);
  }

  /** Диалог выбора папки + открытие как проекта. Возвращает путь или null, если отменили. */
  async pick(): Promise<string | null> {
    const result = await this.rpc.request('dialog.pickFolder', { title: 'Открыть папку проекта' });
    if (!result.path) return null;
    await this.open(result.path);
    return result.path;
  }

  /** Открыть папку как проект: рабочая область заменяется этой одной папкой. */
  async open(root: string): Promise<WorkspaceInfo> {
    return this.apply(await this.rpc.request('workspace.open', { path: root }), 'project');
  }

  /** Добавить папку в рабочую область (несколько корней в одном окне). */
  async addRoot(root: string): Promise<WorkspaceInfo> {
    return this.apply(await this.rpc.request('workspace.addRoot', { path: root }), 'roots');
  }

  /**
   * Убрать корень. Область опустела — это уже «проект закрыт»: рабочее место
   * сбрасывается, как при закрытии папки.
   */
  async removeRoot(root: string): Promise<WorkspaceInfo | null> {
    const info = await this.rpc.request('workspace.removeRoot', { path: root });
    this.info = info;
    this.changeEmitter.fire({ info, reason: info ? 'roots' : 'project' });
    return info;
  }

  /** Сделать корень активным: тот же проект, другая рабочая папка. */
  async setActiveRoot(root: string): Promise<WorkspaceInfo> {
    return this.apply(await this.rpc.request('workspace.setActiveRoot', { path: root }), 'roots');
  }

  async refresh(): Promise<void> {
    if (!this.info) return;
    await this.open(this.info.root);
  }

  private apply(info: WorkspaceInfo, reason: WorkspaceChangeReason): WorkspaceInfo {
    this.info = info;
    this.changeEmitter.fire({ info, reason });
    return info;
  }

  readDir(dir: string): Promise<DirEntry[]> {
    return this.rpc.request('workspace.readDir', { path: dir });
  }

  /**
   * Путь относительно того корня, которому файл принадлежит, — так его показывают
   * статусбар и заголовок вкладки. С несколькими корнями «относительно текущего
   * проекта» уже не годится: файл из второй папки показался бы как `../../…`.
   */
  relative(target: string): string {
    if (this.roots.length === 0) return target;
    const relative = relativeToRoots(this.roots, target);
    return relative || this.name;
  }

  /** Корень, которому принадлежит путь (`null` — файл вне области). */
  ownerOf(target: string): WorkspaceRoot | null {
    return rootForPath(this.roots, target);
  }
}

/**
 * Путь относительно корня — им пользуются крошки, статусбар и запуск.
 *
 * Считаем строками (`node:path` в renderer нет), но разделитель берём из пути:
 * main отдаёт родные, и на Windows это обратные слэши. Со «всегда /» путь внутри
 * проекта не находился, файл выглядел лежащим вне корня, и у него не было кнопки
 * запуска. Общее правило — в `shared/paths`.
 */
export function relativePath(root: string, target: string): string {
  return pathAfter(root, target);
}
