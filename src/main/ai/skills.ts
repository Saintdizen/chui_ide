import { promises as fs, type Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findSkill,
  MAX_SKILL_BODY_CHARS,
  MAX_SKILLS,
  parseSkillFile,
  skillBody,
  type SkillEntry,
  type SkillScope,
} from '../../shared/skills';

/**
 * Чтение навыков с диска.
 *
 * Два места, где лежат навыки:
 *
 *   • `<проект>/.chui/skills/` — свои для этого проекта: их видит и git, и человек
 *     в дереве файлов. Такие навыки касаются именно этого кода: «как выпускать
 *     версию», «как гонять пробы браузера»;
 *   • `~/.chui/skills/` — общие для всех проектов: личные предпочтения вроде
 *     «коммит описательным сообщением с телом». Как и глобальная память, живут
 *     вне проекта, но в отличие от неё лежат файлами на виду.
 *
 * Имя навыка — ключ вызова, поэтому одно имя не может значить две вещи: при
 * совпадении выигрывает проектный (он конкретнее).
 *
 * Файл навыка — `SKILL.md` внутри своей папки либо одиночный `<имя>.md`. Папка
 * без `SKILL.md` пропускается молча: там может лежать что угодно — скрипты
 * навыка, шаблоны, картинки.
 */

/** Где искать навыки: одна подпапка в проекте, одна в домашнем каталоге. */
const SKILLS_DIR = path.join('.chui', 'skills');
/** Файл внутри папки навыка. Одиночный `<имя>.md` рядом — тоже навык. */
const SKILL_FILE = 'SKILL.md';
/** Потолок файла, который читаем ради шапки: остальное всё равно отбросим. */
const MAX_SKILL_FILE_BYTES = MAX_SKILL_BODY_CHARS * 4;

/** Каталог навыков для области; `null` — искать негде (проект не открыт). */
function skillsDirFor(root: string | null, scope: SkillScope, home: string): string | null {
  if (scope === 'workspace') return root ? path.join(root, SKILLS_DIR) : null;
  return path.join(home, SKILLS_DIR);
}

/**
 * Прочитать один навык из файла. Ошибки чтения не всплывают: сломанный навык не
 * повод остаться без остальных.
 */
async function readEntry(file: string, fallbackName: string, scope: SkillScope): Promise<SkillEntry | null> {
  try {
    const text = await fs.readFile(file, 'utf8');
    return parseSkillFile(text.slice(0, MAX_SKILL_FILE_BYTES), { fallbackName, path: file, scope });
  } catch {
    return null;
  }
}

/**
 * Навыки одного каталога. Порядок — по имени: каталог в промпте читают глазами,
 * и «прыгающий» от запуска к запуску список мешал бы сравнивать.
 */
async function scanDir(dir: string, scope: SkillScope): Promise<SkillEntry[]> {
  let items: Dirent[];
  try {
    items = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: SkillEntry[] = [];
  for (const item of items) {
    if (item.name.startsWith('.')) continue;
    if (item.isDirectory()) {
      const entry = await readEntry(path.join(dir, item.name, SKILL_FILE), item.name, scope);
      if (entry) found.push(entry);
      continue;
    }
    // Одиночный файл: `release.md` — навык `release`. `SKILL.md`, лежащий прямо в
    // каталоге навыков, тоже годится, но имени у него нет — берём имя каталога.
    if (!item.isFile() || !item.name.toLowerCase().endsWith('.md')) continue;
    const base = item.name.slice(0, -3);
    const fallbackName = base.toLowerCase() === 'skill' ? path.basename(dir) : base;
    const entry = await readEntry(path.join(dir, item.name), fallbackName, scope);
    if (entry) found.push(entry);
  }

  return found.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Собрать навыки проекта и общие: сначала свои (они конкретнее), потом общие —
 * внутри каждой группы по алфавиту. Проектный выигрывает у общего с тем же именем;
 * список обрезан потолком — каталог идёт в КАЖДЫЙ запрос.
 */
export async function loadSkills(root: string | null, home: string = os.homedir()): Promise<SkillEntry[]> {
  const workspaceDir = skillsDirFor(root, 'workspace', home);
  const own = workspaceDir ? await scanDir(workspaceDir, 'workspace') : [];
  const shared = await scanDir(skillsDirFor(root, 'global', home)!, 'global');

  const taken = new Set(own.map((skill) => skill.name));
  const all = [...own, ...shared.filter((skill) => !taken.has(skill.name))];
  return all.slice(0, MAX_SKILLS);
}

/** Тело навыка для агента; `null` — такого навыка нет (или файл пропал после каталога). */
export async function readSkillBody(
  skills: readonly SkillEntry[],
  name: string,
): Promise<{ entry: SkillEntry; body: string } | null> {
  const entry = findSkill(skills, name);
  if (!entry) return null;
  try {
    const text = await fs.readFile(entry.path, 'utf8');
    const body = skillBody(text.slice(0, MAX_SKILL_FILE_BYTES));
    return body ? { entry, body } : null;
  } catch {
    return null;
  }
}

/**
 * Навыки на время одного прогона: каталог читается один раз (он нужен и в
 * промпте, и инструменту), тело — по требованию. Список на прогон неизменен:
 * иначе агент видел бы в промпте одно, а инструментом получал другое.
 */
export interface SkillLibrary {
  list(): Promise<readonly SkillEntry[]>;
  read(name: string): Promise<{ entry: SkillEntry; body: string } | null>;
}

export function createSkillLibrary(root: string | null): SkillLibrary {
  let pending: Promise<SkillEntry[]> | null = null;
  const list = (): Promise<readonly SkillEntry[]> => {
    pending ??= loadSkills(root);
    return pending;
  };
  return {
    list,
    read: async (name) => readSkillBody(await list(), name),
  };
}
