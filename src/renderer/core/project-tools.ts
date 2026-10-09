import type { RunSettings } from '../../shared/api';
import { nodeTestRunnerFrom, type DeclaredNodeRunner } from '../../shared/node-tests';
import type { RpcClient } from './rpc';
import { Emitter } from './events';

/**
 * Инструменты проекта: чем запускать код и какие задачи в нём есть.
 *
 * Знание о проекте нужно кнопке запуска: Python запускается интерпретатором
 * окружения, Node — менеджером пакетов по файлу блокировки, а не тем, что
 * попалось в PATH. Определяем это один раз на корень проекта и держим снимок —
 * спрашивать файловую систему на каждую отрисовку панели нельзя.
 */

export type NodePackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface ProjectScript {
  name: string;
  command: string;
}

export interface ProjectTools {
  root: string | null;
  /** Менеджер пакетов Node: по блокировке, полю packageManager или настройке. */
  packageManager: NodePackageManager;
  /** Готовая команда интерпретатора Python. */
  pythonCommand: string;
  /** Что показать человеку: путь к окружению или имя из PATH. */
  pythonLabel: string;
  /** Запускается ли Python через окружение проекта (а не системный). */
  pythonFromProject: boolean;
  /** Задачи из `scripts` в package.json. */
  scripts: readonly ProjectScript[];
  /** Найден ли package.json: без него задач Node нет. */
  hasPackageJson: boolean;
  /** Чем запускать TypeScript, если он есть в зависимостях проекта (`tsx`, `ts-node`). */
  tsRunner: string | null;
  /**
   * Чем запускаются тесты проекта: `vitest` или `jest` из зависимостей. null —
   * объявленного раннера нет; годится ли встроенный `node --test`, решает тот,
   * у кого есть карта проекта (там видно, есть ли вообще тестовые файлы).
   */
  testRunner: DeclaredNodeRunner | null;
}

const EMPTY: ProjectTools = {
  root: null,
  packageManager: 'npm',
  pythonCommand: 'python3',
  pythonLabel: 'python3',
  pythonFromProject: false,
  scripts: [],
  hasPackageJson: false,
  tsRunner: null,
  testRunner: null,
};

/** Порядок проверки блокировок: два рядом лежащих файла — редкость, но пусть решает этот список. */
const LOCKFILES: ReadonlyArray<readonly [string, NodePackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
];

/** Где искать виртуальное окружение Python. Windows-пути тоже проверяем: проект может быть переносимым. */
const PYTHON_ENVIRONMENTS: ReadonlyArray<readonly [string, string]> = [
  ['.venv/bin/python', '.venv'],
  ['venv/bin/python', 'venv'],
  ['.venv/Scripts/python.exe', '.venv'],
  ['venv/Scripts/python.exe', 'venv'],
  ['env/bin/python', 'env'],
];

export class ProjectToolsModel {
  private snapshot: ProjectTools = EMPTY;
  private readonly emitter = new Emitter<ProjectTools>();
  readonly onDidChange = this.emitter.event;
  /** Определение идёт в фоне: повторные вызовы для того же корня не нужны. */
  private detecting: Promise<void> | null = null;
  private detectedRoot: string | null = null;

  constructor(
    private readonly rpc: RpcClient,
    private readonly settings: () => RunSettings,
    private readonly platform: string,
  ) {}

  get(): ProjectTools {
    return this.snapshot;
  }

  /** Определить инструменты для корня проекта. Уже определённый корень не перепроверяем. */
  async refresh(root: string | null, force = false): Promise<void> {
    if (!root) {
      this.apply(EMPTY);
      this.detectedRoot = null;
      return;
    }
    if (!force && root === this.detectedRoot) return;
    if (this.detecting) await this.detecting;
    if (root === this.detectedRoot && !force) return;
    this.detecting = this.detect(root).finally(() => {
      this.detecting = null;
    });
    await this.detecting;
  }

  private async detect(root: string): Promise<void> {
    const [manifest, hasPackageJson, python] = await Promise.all([
      this.readManifest(root),
      this.exists(`${root}/package.json`),
      this.detectPython(root),
    ]);

    const chosen = this.settings().packageManager;
    const packageManager: NodePackageManager =
      chosen !== 'auto' ? chosen : (manifest.packageManager ?? (await this.detectLockfile(root)));

    this.detectedRoot = root;
    this.apply({
      root,
      packageManager,
      hasPackageJson,
      scripts: manifest.scripts,
      tsRunner: manifest.tsRunner,
      testRunner: manifest.testRunner,
      ...python,
    });
  }

  private apply(next: ProjectTools): void {
    this.snapshot = next;
    this.emitter.fire(next);
  }

  private async exists(target: string): Promise<boolean> {
    try {
      await this.rpc.request('workspace.stat', { path: target });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Один разбор package.json вместо трёх: задачи, менеджер пакетов и признак
   * раннера TypeScript лежат в одном файле, и читать его трижды незачем.
   */
  private async readManifest(root: string): Promise<{
    scripts: ProjectScript[];
    packageManager: NodePackageManager | null;
    tsRunner: string | null;
    testRunner: DeclaredNodeRunner | null;
  }> {
    const raw = await this.readJson(`${root}/package.json`);
    const scripts: ProjectScript[] = [];
    const source = raw?.scripts;
    if (source && typeof source === 'object') {
      for (const [name, command] of Object.entries(source as Record<string, unknown>)) {
        if (typeof command === 'string') scripts.push({ name, command });
      }
    }

    // Поле `packageManager` пишет corepack — это самый точный источник.
    const field = typeof raw?.packageManager === 'string' ? raw.packageManager.split('@')[0] : '';
    const packageManager =
      field === 'npm' || field === 'pnpm' || field === 'yarn' || field === 'bun' ? (field as NodePackageManager) : null;

    const dependencies = {
      ...((raw?.dependencies as Record<string, unknown>) ?? {}),
      ...((raw?.devDependencies as Record<string, unknown>) ?? {}),
    };
    const tsRunner = 'tsx' in dependencies ? 'npx tsx' : 'ts-node' in dependencies ? 'npx ts-node' : null;

    return { scripts, packageManager, tsRunner, testRunner: nodeTestRunnerFrom(Object.keys(dependencies)) };
  }

  private async readJson(target: string): Promise<Record<string, unknown> | null> {
    try {
      const file = await this.rpc.request('workspace.readFile', { path: target });
      const parsed: unknown = JSON.parse(file.text);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  private async detectLockfile(root: string): Promise<NodePackageManager> {
    for (const [file, manager] of LOCKFILES) {
      if (await this.exists(`${root}/${file}`)) return manager;
    }
    return 'npm';
  }

  /**
   * Интерпретатор Python: сначала явная настройка, потом окружение проекта,
   * и только потом системный. Порядок важен — иначе код запустится не тем
   * Python, зависимости которого видит проект.
   */
  private async detectPython(root: string): Promise<Pick<ProjectTools, 'pythonCommand' | 'pythonLabel' | 'pythonFromProject'>> {
    const configured = this.settings().pythonPath.trim();
    if (configured) {
      return { pythonCommand: shellQuote(configured), pythonLabel: configured, pythonFromProject: false };
    }

    for (const [relative, label] of PYTHON_ENVIRONMENTS) {
      if (await this.exists(`${root}/${relative}`)) {
        return { pythonCommand: shellQuote(`./${relative}`), pythonLabel: `${label} · ./${relative}`, pythonFromProject: true };
      }
    }

    const fallback = this.platform === 'win32' ? 'python' : 'python3';
    return { pythonCommand: fallback, pythonLabel: `${fallback} (системный)`, pythonFromProject: false };
  }
}

/** Путь с пробелами ломает команду в терминале: оборачиваем в кавычки. */
export function shellQuote(value: string): string {
  if (!/[^A-Za-z0-9_./:@%+-]/.test(value)) return value;
  if (value.includes("'")) return `"${value.replace(/"/g, '\\"')}"`;
  return `'${value}'`;
}
