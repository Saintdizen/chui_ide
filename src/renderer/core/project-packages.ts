import type { ProjectPackage } from '../../shared/monorepo';
import { packagesLabel, isMonorepo } from '../../shared/monorepo';
import { Emitter } from './events';
import type { RpcClient } from './rpc';
import type { WorkspaceModel } from './workspace-model';

/**
 * Пакеты текущего проекта: список манифестов и разбивка по ним.
 *
 * В монорепо один репозиторий — много проектов, и полезен не список файлов сам по
 * себе, а «какой пакет задет». Список меняется редко (появился новый `package.json`),
 * поэтому читаем его при открытии папки и отдаём всем, кому нужно, — панель
 * изменений по нему раскладывает правки.
 */
export class ProjectPackagesModel {
  private packages: ProjectPackage[] = [];

  private readonly emitter = new Emitter<readonly ProjectPackage[]>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly rpc: RpcClient,
    private readonly workspace: WorkspaceModel,
  ) {
    workspace.onDidChange(() => void this.reload());
    void this.reload();
  }

  get all(): readonly ProjectPackage[] {
    return this.packages;
  }

  /** Разбивка по пакетам нужна только когда пакетов действительно несколько. */
  get isMonorepo(): boolean {
    return isMonorepo(this.packages);
  }

  /** Подпись списка для интерфейса: «3 пакета». */
  label(): string {
    return packagesLabel(this.packages);
  }

  async reload(): Promise<void> {
    if (!this.workspace.root) {
      this.packages = [];
      this.emitter.fire(this.packages);
      return;
    }
    try {
      const root = this.workspace.root;
      const packages = await this.rpc.request('project.packages');
      // Пока искали, могли открыть другую папку: тогда ответ уже не к месту.
      if (root !== this.workspace.root) return;
      this.packages = packages;
    } catch {
      // Не смогли прочитать манифесты — просто нет разбивки по пакетам.
      this.packages = [];
    }
    this.emitter.fire(this.packages);
  }
}
