import { promises as fs } from 'node:fs';
import path from 'node:path';
import { applyProjectSettingsPatch, sanitizeProjectSettings, type ProjectSettings } from '../shared/project-config';

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
 * Настройки уровня проекта — в `<root>/.chui_ide/settings.json` рядом с кодом,
 * а не в userData: их видно в репозитории, можно версионировать и переносить
 * вместе с проектом. Пути задаются от корня рабочей папки, поэтому один и тот
 * же стор обслуживает любой открытый проект. Макет рабочей области сюда не
 * входит: он общий для всех проектов и живёт в settings.json (userData).
 */
export class ProjectConfigStore {
  private dir(root: string): string {
    return path.join(root, PROJECT_CONFIG_DIR);
  }

  private settingsFile(root: string): string {
    return path.join(this.dir(root), 'settings.json');
  }

  /** Читает настройки проекта; нет папки — пустые настройки. */
  async load(root: string): Promise<ProjectSettings> {
    return sanitizeProjectSettings(await readJson(this.settingsFile(root)));
  }

  /** Дополняет проектные настройки патчем и возвращает новое состояние. */
  async updateSettings(root: string, patch: ProjectSettings): Promise<ProjectSettings> {
    const current = sanitizeProjectSettings(await readJson(this.settingsFile(root)));
    const next = applyProjectSettingsPatch(current, sanitizeProjectSettings(patch));
    await writeJson(this.settingsFile(root), next);
    return next;
  }
}
