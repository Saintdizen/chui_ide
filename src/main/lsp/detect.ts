import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import type { LspServerConfig } from '../../shared/api';
import { matchPresets, presetCommands } from '../../shared/lsp-presets';
import { findEnvironments } from '../python/environments';
import { detectBundledServers } from './bundled';

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
  return [
    command,
    ...pathext.map((ext) => `${command}${ext.toLowerCase()}`),
    ...pathext.map((ext) => `${command}${ext}`),
  ];
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
  const checks = await Promise.all(
    presetCommands().map(async (command) => ((await isOnPath(command)) ? command : null)),
  );
  return checks.filter((command): command is string => command !== null);
}

/**
 * Команды LSP из каталога окружения Python: там живут pylsp, ruff и прочие,
 * поставленные в venv. Отдельно от PATH, потому что сервер в окружении проекта
 * видит его пакеты, а системный — нет.
 */
export async function detectVenvCommands(venvDir: string, platform: string): Promise<string[]> {
  const binDir = platform === 'win32' ? `${venvDir}/Scripts` : `${venvDir}/bin`;
  const checks = await Promise.all(
    presetCommands().map(async (command) => {
      for (const name of executableNames(command)) {
        try {
          await access(path.join(binDir, name), constants.X_OK);
          return path.join(binDir, name);
        } catch {
          // нет здесь — пробуем следующее имя
        }
      }
      return null;
    }),
  );
  return checks.filter((command): command is string => command !== null);
}

/**
 * Серверы по источникам, в порядке приоритета: окружение проекта → поставка → PATH.
 *
 * Отдаём списком списков, а не одним, потому что потребителей двое:
 *   • `lsp.detect` схлопывает их по языку (`mergeByPriority`) — в настройках
 *     у языка один сервер, иначе они спорили бы за документ;
 *   • рантайму нужны ВСЕ кандидаты: названный сервер может не подняться, и его
 *     место должен занять следующий по приоритету (см. `serverCandidates`).
 */
export async function detectLspSources(root: string | null, platform: string): Promise<LspServerConfig[][]> {
  const [commands, bundled] = await Promise.all([detectAvailableCommands(), detectBundledServers()]);
  const environments = root ? await findEnvironments(root, platform) : [];
  const primary = environments.find((environment) => environment.primary);
  const venvCommands = primary ? await detectVenvCommands(primary.path, platform) : [];
  return [matchPresets(venvCommands), bundled, matchPresets(commands)];
}
