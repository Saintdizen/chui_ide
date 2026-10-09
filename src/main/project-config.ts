import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  applyProjectSettingsPatch,
  sanitizeProjectLayout,
  sanitizeProjectSettings,
  type ProjectConfig,
  type ProjectLayout,
  type ProjectSettings,
} from '../shared/project-config';

/** Папка конфигурации в корне проекта. */
export const PROJECT_CONFIG_DIR = '.chui_ide';

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    // Нет файла или битый JSON — это не ошибка: просто нет проектных настроек.
    return null;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Настройки и макет на уровне проекта — в `<root>/.chui_ide/` рядом с кодом,
 * а не в userData: их видно в репозитории, можно версионировать и переносить
 * вместе с проектом. Пути задаются от корня рабочей папки, поэтому один и тот
 * же стор обслуживает любой открытый проект.
 */
export class ProjectConfigStore {
  private dir(root: string): string {
    return path.join(root, PROJECT_CONFIG_DIR);
  }

  private settingsFile(root: string): string {
    return path.join(this.dir(root), 'settings.json');
  }

  private layoutFile(root: string): string {
    return path.join(this.dir(root), 'layout.json');
  }

  /** Читает настройки и макет проекта; нет папки — пустая конфигурация. */
  async load(root: string): Promise<ProjectConfig> {
    const [settings, layout] = await Promise.all([
      readJson(this.settingsFile(root)),
      readJson(this.layoutFile(root)),
    ]);
    return {
      settings: sanitizeProjectSettings(settings),
      layout: sanitizeProjectLayout(layout),
    };
  }

  /** Дополняет проектные настройки патчем и возвращает новое состояние. */
  async updateSettings(root: string, patch: ProjectSettings): Promise<ProjectConfig> {
    const current = sanitizeProjectSettings(await readJson(this.settingsFile(root)));
    const next = applyProjectSettingsPatch(current, sanitizeProjectSettings(patch));
    await writeJson(this.settingsFile(root), next);
    return this.load(root);
  }

  /** Дополняет макет и возвращает новое состояние. */
  async saveLayout(root: string, layout: ProjectLayout): Promise<ProjectLayout> {
    const current = sanitizeProjectLayout(await readJson(this.layoutFile(root)));
    const next = { ...current, ...sanitizeProjectLayout(layout) };
    await writeJson(this.layoutFile(root), next);
    return next;
  }
}
