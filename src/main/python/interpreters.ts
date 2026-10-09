import { execFile } from 'node:child_process';
import {
  comparePythonVersions,
  parsePythonVersion,
  pythonInterpreterLabel,
  type PythonInterpreter,
} from '../../shared/python-env';
import { isOnPath } from '../lsp/detect';

/**
 * Поиск интерпретаторов Python, установленных в системе.
 *
 * Зачем: версии питона живут рядом (`python3.12`, `python3.14`), и не у каждой
 * есть модуль `venv` — окружение из такой версии не создастся. Человек должен
 * видеть список и выбирать сам, а не упираться в «ensurepip is not available».
 *
 * Ищем по именам в PATH (как `detectAvailableCommands` для LSP): `python3`
 * и `python` обычно указывают на версию по умолчанию, а `python3.14` — на
 * конкретную. На Windows добавляется лаунчер `py -0p`, который сам знает все
 * установленные версии и их пути.
 */

/** Имена, которые проверяем в PATH: сначала «умные», затем конкретные версии. */
function candidateCommands(platform: string): string[] {
  const names = ['python3', 'python'];
  // Разброс версий с запасом: список закрытый, а лишние имена просто не найдутся.
  for (let minor = 20; minor >= 6; minor -= 1) names.push(`python3.${minor}`);
  for (let minor = 13; minor >= 6; minor -= 1) names.push(`python${minor}`);
  if (platform === 'win32') names.push('py');
  return names;
}

/** Все интерпретаторы системы: новейшая версия — первой. */
export async function findInterpreters(platform: string): Promise<PythonInterpreter[]> {
  const found: PythonInterpreter[] = [];
  // Дедупликация по версии: разные имена (python3 и python3.14) часто — один и тот же питон.
  const seen = new Set<string>();

  const add = (command: string, version: string | null): void => {
    if (!version || seen.has(version)) return;
    seen.add(version);
    found.push({ command, version, label: pythonInterpreterLabel(version) });
  };

  for (const command of candidateCommands(platform)) {
    // `py` без аргумента отвечает версией по умолчанию — конкретные берём из `py -0p`.
    if (command === 'py') continue;
    if (!(await isOnPath(command))) continue;
    add(command, await versionOf(command));
  }

  if (platform === 'win32') {
    for (const item of await pyLauncherInterpreters()) add(item.command, item.version);
  }

  return found.sort((a, b) => comparePythonVersions(b.version, a.version));
}

/** Ответ `python --version`: часть версий печатает в stderr, поэтому читаем оба потока. */
function versionOf(command: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, ['--version'], { timeout: 4000, windowsHide: true }, (_error, stdout, stderr) => {
      resolve(parsePythonVersion(`${stdout}\n${stderr}`));
    });
  });
}

/**
 * Лаунчер Windows `py -0p` печатает установленные версии с путями, например
 * ` -3.14-64  C:\Python314\python.exe`. Разбираем строку целиком: нам нужны
 * и версия, и путь, которым потом запускается создание окружения.
 */
async function pyLauncherInterpreters(): Promise<PythonInterpreter[]> {
  const output = await runCapture('py', ['-0p']);
  const result: PythonInterpreter[] = [];
  for (const line of output.split(/\r?\n/)) {
    const version = /(\d+\.\d+)/.exec(line);
    const path = /([A-Za-z]:\\[^\s]+\.exe)/i.exec(line);
    if (!version || !path) continue;
    result.push({
      command: path[1]!,
      version: version[1]!,
      label: pythonInterpreterLabel(version[1]!),
    });
  }
  return result;
}

/** Запустить команду и вернуть её вывод; ошибки не бросаем — вернём пустую строку. */
function runCapture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 4000, windowsHide: true }, (_error, stdout) => resolve(stdout ?? ''));
  });
}
