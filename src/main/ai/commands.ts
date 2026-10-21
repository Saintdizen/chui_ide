import { promises as fs, type Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_COMMAND_PROMPT_CHARS, MAX_COMMANDS, parseCommandFile, type ProjectCommand } from '../../shared/commands';

/**
 * Чтение команд проекта с диска.
 *
 * Два места, как у навыков:
 *
 *   • `<проект>/.chui/commands/` — команды этого проекта: их видит git, они
 *     уезжают вместе с кодом и касаются именно его («прогони пробы браузера»);
 *   • `~/.chui/commands/` — личные, годные в любом проекте («проверь дифф и напиши
 *     сообщение коммита»).
 *
 * В отличие от навыков папки внутри не разбираем: команда — это один текстовый
 * файл, и раскладывать его по каталогам незачем. Имя команды — имя файла.
 *
 * Команды нужны интерфейсу, а не модели: они подставляют текст в поле ввода.
 * Поэтому никакого каталога в промпте нет — только список для меню.
 */

/** Где искать команды: одна подпапка в проекте, одна в домашнем каталоге. */
const COMMANDS_DIR = path.join('.chui', 'commands');
/** Потолок файла, который читаем: остальное всё равно отбросим. */
const MAX_COMMAND_FILE_BYTES = MAX_COMMAND_PROMPT_CHARS * 4;

/** Каталог команд для области; `null` — искать негде (проект не открыт). */
/** Где лежат команды: в проекте или в домашней папке. */
type ProjectCommandScope = 'workspace' | 'global';

function commandsDirFor(root: string | null, scope: ProjectCommandScope, home: string): string | null {
  if (scope === 'workspace') return root ? path.join(root, COMMANDS_DIR) : null;
  return path.join(home, COMMANDS_DIR);
}

/** Прочитать одну команду из файла. Ошибки чтения не всплывают: сломанный файл — не повод остаться без остальных. */
async function readEntry(
  file: string,
  fallbackName: string,
  scope: ProjectCommandScope,
): Promise<ProjectCommand | null> {
  try {
    const text = await fs.readFile(file, 'utf8');
    return parseCommandFile(text.slice(0, MAX_COMMAND_FILE_BYTES), { fallbackName, path: file, scope });
  } catch {
    return null;
  }
}

/**
 * Команды одного каталога. Порядок — по имени: меню читают глазами, и «прыгающий»
 * от запуска к запуску список мешал бы искать.
 */
async function scanDir(dir: string, scope: ProjectCommandScope): Promise<ProjectCommand[]> {
  let items: Dirent[];
  try {
    items = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: ProjectCommand[] = [];
  for (const item of items) {
    if (item.name.startsWith('.')) continue;
    if (!item.isFile() || !item.name.toLowerCase().endsWith('.md')) continue;
    const entry = await readEntry(path.join(dir, item.name), item.name.slice(0, -3), scope);
    if (entry) found.push(entry);
  }
  return found.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Собрать команды проекта и общие: сначала свои (они конкретнее), потом общие —
 * внутри каждой группы по алфавиту. Проектная выигрывает у общей с тем же именем.
 */
export async function loadCommands(root: string | null, home: string = os.homedir()): Promise<ProjectCommand[]> {
  const workspaceDir = commandsDirFor(root, 'workspace', home);
  const own = workspaceDir ? await scanDir(workspaceDir, 'workspace') : [];
  const shared = await scanDir(commandsDirFor(root, 'global', home)!, 'global');

  const taken = new Set(own.map((command) => command.name));
  const all = [...own, ...shared.filter((command) => !taken.has(command.name))];
  return all.slice(0, MAX_COMMANDS);
}
