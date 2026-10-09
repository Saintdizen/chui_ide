import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { presetCommands } from '../../shared/lsp-presets';

/**
 * Поиск команд LSP в PATH. Отдельно от сервиса: это про систему, а не про
 * запуск серверов. `which` в Node нет, а тянуть зависимость ради этого не стоит —
 * проходим по каталогам PATH сами.
 */

/** Каталоги PATH в порядке проверки. */
function pathDirs(): string[] {
  const raw = process.env.PATH ?? '';
  return raw.split(path.delimiter).filter(Boolean);
}

/** Расширения исполняемых файлов: на Windows команда без расширения не запустится. */
function executableNames(command: string): string[] {
  if (process.platform !== 'win32') return [command];
  const pathext = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean);
  return [command, ...pathext.map((ext) => `${command}${ext.toLowerCase()}`), ...pathext.map((ext) => `${command}${ext}`)];
}

/** Есть ли команда в PATH как исполняемый файл. */
export async function isOnPath(command: string): Promise<boolean> {
  const names = executableNames(command);
  for (const dir of pathDirs()) {
    for (const name of names) {
      try {
        await access(path.join(dir, name), constants.X_OK);
        return true;
      } catch {
        // нет здесь — идём дальше
      }
    }
  }
  return false;
}

/** Какие из известных команд LSP реально есть в PATH. */
export async function detectAvailableCommands(): Promise<string[]> {
  const checks = await Promise.all(presetCommands().map(async (command) => ((await isOnPath(command)) ? command : null)));
  return checks.filter((command): command is string => command !== null);
}
