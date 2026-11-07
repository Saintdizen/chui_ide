import { promises as fs } from 'node:fs';
import path from 'node:path';
import { applyProjectSettingsPatch, sanitizeProjectSettings, type ProjectSettings } from '../shared/project-config';
import { sanitizeLayout, type LayoutSettings } from '../shared/api/settings';

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
 * же стор обслуживает любой открытый проект.
 *
 * Макет рабочей области лежит отдельным файлом `layout.json`: он меняется от
 * каждого перетаскивания границы и не должен поднимать шум вокруг settings.json,
 * который люди правят руками и версионируют. Нет файла — значит проект живёт
 * с общим макетом (VS Code и Zed держат layout на workspace так же).
 */
export class ProjectConfigStore {
  private dir(root: string): string {
    return path.join(root, PROJECT_CONFIG_DIR);
  }

  private settingsFile(root: string): string {
    return path.join(this.dir(root), 'settings.json');
  }

  /** Макет рабочей области этого проекта: размеры и видимость панелей. */
  private layoutFile(root: string): string {
    return path.join(this.dir(root), 'layout.json');
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

  /**
   * Макет проекта; `null` — своего макета нет, действует общий.
   * `null` и «макет по умолчанию» — разные вещи: второй означал бы, что проект
   * намеренно сброшен к умолчаниям, и перекрыл бы общие настройки.
   */
  async loadLayout(root: string): Promise<LayoutSettings | null> {
    const raw = await readJson(this.layoutFile(root));
    return raw && typeof raw === 'object' ? sanitizeLayout(raw as Partial<LayoutSettings>) : null;
  }

  /** Сохраняет макет проекта целиком: его пишут по готовому состоянию, а не патчем. */
  async saveLayout(root: string, layout: LayoutSettings): Promise<LayoutSettings> {
    const next = sanitizeLayout(layout);
    await writeJson(this.layoutFile(root), next);
    return next;
  }

  /** Забывает макет проекта: после этого снова действует общий. */
  async clearLayout(root: string): Promise<void> {
    await fs.rm(this.layoutFile(root), { force: true });
  }
}
