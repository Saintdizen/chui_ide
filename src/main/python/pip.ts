import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  RpcErrorCode,
  type PythonInstallOptions,
  type PythonInstallResult,
  type VenvProgressPayload,
} from '../../shared/api';
import { parsePipList, type InstalledPackage } from '../../shared/python-packages';
import { RpcFailure } from '../ipc/router';
import { projectEnv } from '../project-env';
import { runCommand } from './environments';

/**
 * Пакеты главного окружения: что стоит и как поставить недостающее.
 *
 * Живёт в main: здесь процессы и диск. Renderer получает готовый список и поток
 * вывода — ровно как при создании окружения, поэтому установка рисуется тем же
 * логом. Терминал для этого не нужен: pip запускается напрямую интерпретатором
 * проекта, и человек видит шаги, а не приглашение оболочки.
 */

/**
 * Установленные пакеты окружения. Спрашиваем pip интерпретатора проекта: только
 * он знает, что реально стоит в этом окружении, а не в системе.
 */
export function installedPackages(python: string, cwd?: string): Promise<InstalledPackage[]> {
  return new Promise((resolve, reject) => {
    execFile(
      python,
      ['-m', 'pip', 'list', '--format=json', '--disable-pip-version-check'],
      { cwd, timeout: 20_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new RpcFailure(RpcErrorCode.Internal, `Не удалось получить список пакетов: ${stderr.trim() || error.message}`));
          return;
        }
        resolve(parsePipList(stdout));
      },
    );
  });
}

/**
 * Поставить пакеты в главное окружение проекта.
 *
 * Ставим двумя шагами: сначала `requirements.txt` (он про проект целиком), потом
 * явные пакеты (то, что выбрал человек или подсказали импорты). Порядок важен —
 * явные пакеты могут уточнить версию поверх файла зависимостей.
 */
export async function installPackages(
  root: string,
  python: string,
  options: PythonInstallOptions,
  emit: (event: VenvProgressPayload) => void,
  signal?: AbortSignal,
): Promise<PythonInstallResult> {
  const packages = [...new Set((options.packages ?? []).map((name) => name.trim()).filter(Boolean))];
  const requirements = path.join(root, 'requirements.txt');
  const withRequirements = options.requirements === true && existsSync(requirements);

  if (packages.length === 0 && !withRequirements) {
    throw new RpcFailure(RpcErrorCode.InvalidParams, 'Нечего ставить: не выбраны пакеты и нет requirements.txt');
  }

  // Переменные проекта: приватные индексы и токены в `.env` — обычное дело.
  const env = await projectEnv(root);
  const installed: string[] = [];

  if (withRequirements) {
    emit({ type: 'step', message: 'Ставлю зависимости из requirements.txt…' });
    await runCommand(python, ['-m', 'pip', 'install', '-r', requirements], root, emit, signal, env);
    installed.push('requirements.txt');
  }

  if (packages.length > 0) {
    emit({ type: 'step', message: `Ставлю пакеты: ${packages.join(', ')}…` });
    await runCommand(python, ['-m', 'pip', 'install', ...packages], root, emit, signal, env);
    installed.push(...packages);
  }

  emit({ type: 'done', message: 'Готово' });
  return { installed };
}
