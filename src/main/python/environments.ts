import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  installPackages,
  parsePyvenvCfg,
  resolveVenvTarget,
  shortenHomePath,
  VENV_CANDIDATES,
  VENV_DIR_NAMES,
  venvPythonPath,
  venvActivateCommand,
  type PythonEnvironment,
  type VenvLookup,
} from '../../shared/python-env';
import { isInsidePath } from '../../shared/paths';
import {
  RpcErrorCode,
  type CreateVenvOptions,
  type CreateVenvResult,
  type VenvProgressPayload,
} from '../../shared/api';
import { RpcFailure } from '../ipc/router';

/**
 * Python-окружения проекта: какие есть, какое главное и как создать новое.
 *
 * Живёт в main, потому что всё здесь — файловая система и процессы. Renderer
 * получает готовый список и команды: он не знает ни путей, ни платформы.
 */

/* Типы окружений объявлены в контракте: renderer и main видят одно и то же. */

/** Найденные окружения проекта, главное — первым. */
export async function findEnvironments(root: string, platform: string): Promise<PythonEnvironment[]> {
  const found: PythonEnvironment[] = [];
  const seen = new Set<string>();

  for (const [dir, relativePython] of VENV_CANDIDATES) {
    const venvDir = path.join(root, dir);
    const python = path.join(root, relativePython);
    const key = path.resolve(venvDir);
    if (seen.has(key)) continue;

    const exists = await isFile(python);
    if (!exists) continue;
    seen.add(key);

    found.push({
      path: venvDir,
      relative: toPosix(path.relative(root, venvDir)),
      python,
      label: dir,
      version: await readVenvVersion(venvDir),
      primary: found.length === 0,
    });
  }

  // Окружения дальше корня: вложенные папки вроде `backend/.venv`. Ищем на
  // один уровень в глубину — глубже начинается чужой код или подпроект.
  for (const child of await safeDirs(root)) {
    if (child.name === '.git' || child.name === 'node_modules') continue;
    for (const name of VENV_DIR_NAMES) {
      const python = venvPythonPath(path.join(child.path, name), platform);
      const key = path.resolve(path.join(child.path, name));
      if (seen.has(key) || !(await isFile(python))) continue;
      seen.add(key);
      found.push({
        path: path.join(child.path, name),
        relative: toPosix(path.relative(root, path.join(child.path, name))),
        python,
        label: `${child.name}/${name}`,
        version: await readVenvVersion(path.join(child.path, name)),
        primary: false,
      });
    }
  }

  return found;
}

/**
 * Создать окружение и, по желанию, поставить в него пакеты.
 *
 * Вывод команд уезжает событиями: `python -m venv` и `pip install` идут
 * десятки секунд, и человек должен видеть, что происходит, а не пустое окно.
 */
export async function createVenv(
  root: string,
  home: string,
  options: CreateVenvOptions,
  emit: (event: VenvProgressPayload) => void,
  signal?: AbortSignal,
): Promise<CreateVenvResult> {
  const target = resolveVenvTarget({ root, home, location: options.location, name: options.name, path: options.path });
  if ('error' in target) throw new RpcFailure(RpcErrorCode.InvalidParams, target.error);

  const venvDir = target.dir;
  if (await exists(venvDir)) {
    throw new RpcFailure(RpcErrorCode.InvalidParams, `Каталог уже существует: ${target.label}`);
  }
  // Родителя может не быть: свою папку человек вписал руками, а `~/.venvs`
  // появляется только вместе с первым общим окружением.
  await fs.mkdir(path.dirname(venvDir), { recursive: true }).catch(() => undefined);

  const base = options.base?.trim() || defaultLauncher();

  try {
    emit({ type: 'step', message: `Создаю окружение ${target.label}…` });
    await runCommand(base, ['-m', 'venv', venvDir], root, emit, signal);

    const python = venvPythonPath(venvDir, process.platform);
    if (!(await isFile(python))) {
      throw new RpcFailure(RpcErrorCode.Internal, 'Окружение создано, но интерпретатор не найден');
    }

    const installed: string[] = [];
    // Чистое окружение — это только питон и pip. Всё остальное ставит человек сам
    // (`pip install -r requirements.txt` в терминале), иначе пины проекта молча
    // понизят то, что уже стоит в окружении.
    if (options.clean) {
      emit({ type: 'step', message: 'Окружение чистое: пакеты не ставлю' });
    }
    if (options.installRequirements && !options.clean) {
      const requirements = path.join(root, 'requirements.txt');
      if (await isFile(requirements)) {
        emit({ type: 'step', message: 'Ставлю зависимости из requirements.txt…' });
        await runCommand(python, ['-m', 'pip', 'install', '-r', requirements], root, emit, signal);
        installed.push('requirements.txt');
      } else {
        emit({ type: 'step', message: 'requirements.txt не найден — пропускаю' });
      }
    }

    const packages = options.clean ? [] : installPackages(options.preset ?? 'empty');
    if (packages.length > 0) {
      emit({ type: 'step', message: `Ставлю пакеты: ${packages.join(', ')}…` });
      await runCommand(python, ['-m', 'pip', 'install', ...packages], root, emit, signal);
      installed.push(...packages);
    }

    emit({ type: 'done', message: 'Готово' });
    const inside = isInsidePath(root, venvDir);
    return {
      environment: {
        path: venvDir,
        // Окружение вне проекта от корня не считается: путь из `../../..` человеку
        // ничего не говорит. Показываем его сокращённым через `~`.
        relative: inside ? toPosix(path.relative(root, venvDir)) : shortenHomePath(venvDir, home),
        python,
        label: target.label,
        version: await readVenvVersion(venvDir),
        // Вне проекта окружение основным не становится: поиск в проекте его не видит
        // (см. `findEnvironments`) — его назначают интерпретатором проекта вручную.
        primary: inside,
      },
      installed,
    };
  } catch (error) {
    // `python -m venv` при сбое оставляет половину каталога (например, без
    // ensurepip). Убираем её: иначе повтор упрётся в «каталог уже существует»,
    // а половина окружения выглядит как рабочее.
    await fs.rm(venvDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Интерпретатор основного окружения — синхронно. Нужен там, где ждать нельзя:
 * языковой сервер спрашивает путь прямо во время инициализации.
 */
export function findPrimaryVenvSync(root: string): string | null {
  for (const [, relativePython] of VENV_CANDIDATES) {
    const python = path.join(root, relativePython);
    if (existsSync(python)) return python;
  }
  return null;
}

/**
 * Интерпретатор, которым пользуются запуск и подсказки.
 *
 * Порядок тот же, что у запуска: явная настройка важнее окружения проекта.
 * Раньше языковой сервер брал только `findPrimaryVenvSync` — и подсказки шли с
 * одного питона, а код запускался другим. Голая команда (`python3`) серверу
 * путём не служит: её разрешает PATH. Нет выбора вовсе — решает окружение.
 */
export function pythonInterpreterFor(root: string | null, configured: string): string | null {
  if (!root) return null;
  const value = configured.trim();
  if (!value) return findPrimaryVenvSync(root);
  if (path.isAbsolute(value)) return value;
  // Относительный путь вроде `./.venv/bin/python` — от корня проекта.
  if (value.includes('/') || value.includes('\\')) return path.resolve(root, value);
  return null;
}

/** Команда активации окружения: её набирает терминал, чтобы venv был активен. */
export function activateCommand(root: string, venvPath: string, platform: string): string {
  // Окружение вне проекта относительно корня не записать: `../../../.venvs/x`
  // человеку ничего не говорит и разваливается, если оболочка сменила каталог.
  const relative = isInsidePath(root, venvPath) ? toPosix(path.relative(root, venvPath)) || '.' : toPosix(venvPath);
  return venvActivateCommand(relative, platform);
}

/**
 * Окружение по папке, которую указал человек: своё, созданное раньше и, может быть,
 * не в этом проекте. Такого не находит поиск окружений в проекте (`findEnvironments`)
 * — его указывают руками, а нам остаётся проверить, что это правда окружение.
 *
 * Признак окружения — `pyvenv.cfg` рядом с интерпретатором. Одного каталога `bin`
 * мало: он бывает и у системного питона, и активировать там нечего.
 *
 * Папку могли указать и «на уровень выше» (`~/.venvs`, `~/projects`): в ней смотрим
 * подпапки и берём окружение, если оно там одно. Несколько — это выбор человека, а
 * не наш: перечисляем их в `candidates`, чтобы он указал конкретное.
 */
export async function lookupVenv(
  dir: string,
  root: string | null,
  home: string,
  platform: string,
): Promise<VenvLookup> {
  const target = path.resolve(dir);
  if (!(await exists(target))) {
    return { environment: null, candidates: [], reason: `Папка не найдена: ${shortenHomePath(target, home)}` };
  }

  const found = await environmentAt(target, root, home, platform);
  if (found) return { environment: found, candidates: [], reason: null };

  const candidates: PythonEnvironment[] = [];
  for (const child of await safeDirs(target)) {
    const environment = await environmentAt(child.path, root, home, platform);
    if (environment) candidates.push(environment);
  }

  if (candidates.length === 1) return { environment: candidates[0]!, candidates: [], reason: null };
  if (candidates.length > 1) {
    const labels = candidates.map((environment) => environment.label).join(', ');
    return {
      environment: null,
      candidates,
      reason: `В этой папке несколько окружений (${labels}) — выберите папку конкретного`,
    };
  }

  return {
    environment: null,
    candidates: [],
    reason: 'В папке нет виртуального окружения: нужен каталог с pyvenv.cfg и bin/python',
  };
}

/** Окружение в этом самом каталоге; `null` — не окружение. */
async function environmentAt(
  dir: string,
  root: string | null,
  home: string,
  platform: string,
): Promise<PythonEnvironment | null> {
  const python = venvPythonPath(dir, platform);
  if (!(await isFile(python))) return null;
  if (!(await isFile(path.join(dir, 'pyvenv.cfg')))) return null;

  const inside = root !== null && isInsidePath(root, dir);
  return {
    path: dir,
    // Вне проекта путь от корня не считается: `../../..` человеку ничего не говорит.
    relative: inside ? toPosix(path.relative(root!, dir)) : shortenHomePath(dir, home),
    python,
    label: inside ? toPosix(path.relative(root!, dir)) : shortenHomePath(dir, home),
    version: await readVenvVersion(dir),
    // Основным окружение становится только внутри проекта: внешнее поиск не увидит,
    // его назначают интерпретатором проекта (см. `onCreated` в окне создания).
    primary: inside,
  };
}

/**
 * Каталог окружения, в котором лежит интерпретатор: `<venv>/bin/python` или
 * `<venv>/Scripts/python.exe`. Окружение узнаём по `pyvenv.cfg` рядом: сам по себе
 * каталог `bin` бывает и у системного питона, а активировать там нечего.
 */
export function venvDirOfPython(python: string): string | null {
  const dir = path.dirname(python);
  const name = path.basename(dir).toLowerCase();
  if (name !== 'bin' && name !== 'scripts') return null;
  const venvDir = path.dirname(dir);
  return existsSync(path.join(venvDir, 'pyvenv.cfg')) ? venvDir : null;
}

/**
 * Команда активации для того интерпретатора, которым работают запуск и тесты.
 *
 * Обычный путь — главное окружение проекта; но интерпретатор можно назвать путём
 * в настройке (`run.pythonPath` или выбранный для проекта), и тогда окружение может
 * лежать где угодно — например, общее в `~/.venvs`. Без этого терминал работал бы
 * без venv, а человек считал бы его активным.
 */
export function activationForInterpreter(root: string | null, configured: string, platform: string): string | null {
  const python = pythonInterpreterFor(root, configured);
  if (!python) return null;
  const venvDir = venvDirOfPython(python);
  if (!venvDir) return null;
  return activateCommand(root ?? venvDir, venvDir, platform);
}

/* ── вспомогательное ────────────────────────────────────────────────────── */

export async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  emit: (event: VenvProgressPayload) => void,
  signal?: AbortSignal,
  extraEnv?: Record<string, string>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...extraEnv, NO_COLOR: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_NO_INPUT: '1' },
      windowsHide: true,
    });

    // Копим вывод: при сбое он — единственный источник причины, а человек
    // видит только последнюю строку в тосте — она и должна быть осмысленной.
    const output: string[] = [];
    const onData = (chunk: Buffer): void => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        output.push(line);
        emit({ type: 'output', message: line });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const onAbort = (): void => {
      child.kill();
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort);
      reject(new RpcFailure(RpcErrorCode.Internal, `Не удалось запустить ${command}: ${error.message}`));
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new RpcFailure(RpcErrorCode.Cancelled, 'Отменено'));
      if (code === 0) return resolve();
      reject(new RpcFailure(RpcErrorCode.Internal, failureMessage(command, args, code, output)));
    });
  });
}

/**
 * Понятная причина сбоя: последняя содержательная строка вывода и подсказка для
 * двух самых частых осечек на Debian/Ubuntu, где venv и pip вынесены в отдельный
 * пакет `python3.X-venv`: `venv` без ensurepip не может создать окружение, а уже
 * созданное окружение без pip не может ставить пакеты.
 */
export function failureMessage(
  command: string,
  args: string[],
  code: number | null,
  output: readonly string[],
): string {
  const text = output.join('\n');
  const last = [...output].reverse().find((line) => line.trim()) ?? '';
  const base = `${command} ${args.join(' ')} — код выхода ${code}${last ? `: ${last}` : ''}.`;
  if (/ensurepip is not available/i.test(text)) {
    return `${base} У этого интерпретатора нет модуля venv: на Debian/Ubuntu поставьте пакет python3.X-venv или выберите другой интерпретатор в списке.`;
  }
  if (/No module named pip/i.test(text)) {
    return `${base} В этом окружении нет pip: оно создано без него (на Debian/Ubuntu нужен пакет python3.X-venv) — поставьте pip или выберите интерпретатор с ним.`;
  }
  return base;
}

/** Первый подходящий интерпретатор: `python3`, затем `python`, затем `py`. */
function defaultLauncher(): string {
  return process.platform === 'win32' ? 'python' : 'python3';
}

/** Версия окружения из `pyvenv.cfg`, если файл есть. */
async function readVenvVersion(venvDir: string): Promise<string | null> {
  const text = await fs.readFile(path.join(venvDir, 'pyvenv.cfg'), 'utf8').catch(() => null);
  return text ? parsePyvenvCfg(text).version : null;
}

async function isFile(target: string): Promise<boolean> {
  return fs
    .stat(target)
    .then((stat) => stat.isFile())
    .catch(() => false);
}

async function exists(target: string): Promise<boolean> {
  return fs
    .stat(target)
    .then(() => true)
    .catch(() => false);
}

async function safeDirs(dir: string): Promise<Array<{ name: string; path: string }>> {
  const dirents = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  return dirents
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: path.join(dir, entry.name) }));
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}
