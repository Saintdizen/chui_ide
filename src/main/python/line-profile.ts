import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { type LineProfile, parseLineProfile } from '../../shared/line-profile';
import { projectEnv } from '../project-env';

/**
 * Профилировщик строк для Python — свой, на стандартной библиотеке.
 *
 * Обычный `cProfile` считает по функциям, а не по строкам, а `line_profiler` надо
 * ставить и украшать код декоратором. Здесь же запускается ОБЁРТКА на stdlib: она
 * исполняет целевой файл через `runpy` под `sys.settrace` и записывает в JSON, сколько
 * раз и сколько времени прошло на каждой строке. Время — СВОЁ: пока строка ждёт
 * вызванную из неё функцию, это время считается её строке, а не строке вызова; иначе
 * «горячей» всегда оказывалась бы строка с вызовом, и узкое место не было бы видно.
 * Ничего ставить не нужно — работает из коробки, как `python -m trace`, но с временем.
 *
 * Обёртка пишется во временный файл при каждом запуске: так она не зависит от упаковки
 * ресурсов (в собранном приложении ресурсов рядом нет), и её видно глазами при отладке.
 * Трассировка идёт только по файлам проекта и самому скрипту — ткнуть во внутренности
 * стандартной библиотеки значило бы утопить результат в мусоре.
 *
 * Цена честная: `sys.settrace` замедляет программу на порядок и не видит чужие потоки.
 * Для разового «где узкое место» этого достаточно; это записано и в README.
 */

/** Обёртка: тот же код, что проверен вживую на `python3` (см. комментарии в отчёте). */
const WRAPPER_SOURCE = `"""Профилировщик строк на стандартной библиотеке: время и число исполнений.

Запускается так: python line-profile.py --out out.json --root КОРЕНЬ СКРИПТ.
Исполняет скрипт через runpy под sys.settrace и пишет отчёт в JSON.
"""
import argparse
import json
import os
import runpy
import sys
import time
import traceback

stats = {}
marks = {}
target = ""
root = ""
WRAPPER = os.path.abspath(__file__)


def keep(name):
    """Профилируем только скрипт и файлы проекта: stdlib — не наш код."""
    if name.startswith("<") or name == WRAPPER:
        return False
    if name == target:
        return True
    return bool(root) and os.path.abspath(name).startswith(root + os.sep)


def record(frame, now):
    """Начислить время, прошедшее с прошлой отметки кадра, его текущей строке."""
    mark = marks.get(id(frame))
    if mark is None:
        return
    name, line, started = mark
    rec = stats.setdefault((name, line), [0, 0])
    rec[0] += 1
    rec[1] += now - started


def pause(frame, now):
    """Снять кадр с учёта на время вызова ребёнка: его время — не наша строка."""
    if id(frame) in marks:
        record(frame, now)
        marks[id(frame)] = None


def resume(frame, now):
    """Вернуть кадр в учёт, когда ребёнок закончил: время снова идёт его строке."""
    if id(frame) in marks:
        marks[id(frame)] = (frame.f_code.co_filename, frame.f_lineno, now)


def local(frame, event, arg):
    now = time.perf_counter_ns()
    if event == "line":
        record(frame, now)
        marks[id(frame)] = (frame.f_code.co_filename, frame.f_lineno, now)
    elif event == "return":
        record(frame, now)
        marks.pop(id(frame), None)
        # Родитель вернулся из вызова — снова считаем время его строке.
        if frame.f_back is not None:
            resume(frame.f_back, now)
    return local


def global_tracer(frame, event, arg):
    if event == "call":
        name = frame.f_code.co_filename
        if not keep(name):
            return None
        now = time.perf_counter_ns()
        # Время, пока родитель ЖДАЛ вызова, принадлежит не ему, а ребёнку: снимаем
        # родителя с учёта. Иначе «горячей» оказалась бы строка вызова, а не тело.
        if frame.f_back is not None:
            pause(frame.f_back, now)
        marks[id(frame)] = (name, frame.f_lineno, now)
        return local
    return None


def main():
    global target, root
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--root", default="")
    parser.add_argument("script")
    parser.add_argument("script_args", nargs="*")
    args = parser.parse_args()

    target = os.path.abspath(args.script)
    root = os.path.abspath(args.root) if args.root else ""
    sys.argv = [target] + list(args.script_args)
    sys.path.insert(0, os.path.dirname(target))

    code, error = 0, None
    started = time.perf_counter()
    sys.settrace(global_tracer)
    try:
        runpy.run_path(target, run_name="__main__")
    except SystemExit as exc:
        code = exc.code if isinstance(exc.code, int) else 0
    except BaseException:
        error = traceback.format_exc()
        code = 1
    finally:
        sys.settrace(None)
    elapsed = time.perf_counter() - started

    files = {}
    for (name, line), rec in stats.items():
        if line < 1:
            continue
        files.setdefault(name, []).append([line, rec[0], rec[1]])
    for rows in files.values():
        rows.sort()

    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(
            {"files": files, "elapsedNs": int(elapsed * 1e9), "exitCode": code, "error": error},
            handle,
            ensure_ascii=False,
        )


if __name__ == "__main__":
    main()
`;

/** Предел времени прогона: профилирование медленное, но вечно висеть не должно. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Хвост вывода программы: показываем его целиком не нужно, только суть. */
const MAX_OUTPUT = 20_000;

export interface LineProfileRun {
  /** Разобранный профиль (пустой, если прогон не удался). */
  profile: LineProfile;
  /** Что программа напечатала — хвост, для показа. */
  stdout: string;
  stderr: string;
  /** Прогон не состоялся вовсе (не запустился, истёк таймаут, отчёт не читается). */
  failed: boolean;
  /** Пояснение к неудаче для интерфейса; `null` — всё в порядке. */
  message: string | null;
}

export interface LineProfileOptions {
  root: string;
  python: string;
  path: string;
  /** Куда положить временные файлы (в приложении — системный temp). */
  tempDir: string;
  /** Аргументы командной строки для профилируемого скрипта. */
  args?: readonly string[];
  timeoutMs?: number;
}

/** Запустить скрипт под обёрткой и вернуть разобранный профиль. */
export async function runLineProfile(options: LineProfileOptions): Promise<LineProfileRun> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let dir: string;
  try {
    dir = await fs.mkdtemp(path.join(options.tempDir, 'chui-profile-'));
  } catch (error) {
    return failedRun(`Не удалось создать временный каталог: ${messageOf(error)}`);
  }

  const scriptPath = path.join(dir, 'line-profile.py');
  const outPath = path.join(dir, 'profile.json');
  try {
    await fs.writeFile(scriptPath, WRAPPER_SOURCE, 'utf8');
  } catch (error) {
    return failedRun(`Не удалось записать профилировщик: ${messageOf(error)}`);
  }

  const env = { ...process.env, ...(await projectEnv(options.root)), PYTHONIOENCODING: 'utf-8', NO_COLOR: '1' };
  const cli = [
    scriptPath,
    '--out',
    outPath,
    '--root',
    options.root,
    path.resolve(options.path),
    ...(options.args ?? []),
  ];

  const run = await spawnProfile(options.python, cli, options.root, env, timeoutMs);
  if (run.error !== null) {
    await cleanup(dir);
    return failedRun(run.error, run.stdout, run.stderr);
  }

  let text: string | null = null;
  try {
    text = await fs.readFile(outPath, 'utf8');
  } catch {
    text = null;
  }
  await cleanup(dir);

  if (text === null) {
    // Отчёт не появился: скорее всего скрипт не запустился (нет интерпретатора, ошибка
    // в самом скрипте до записи). Хвост stderr и есть объяснение.
    const tail = run.stderr.trim().split('\n').slice(-3).join('\n');
    return {
      profile: parseLineProfile('{}'),
      stdout: run.stdout,
      stderr: run.stderr,
      failed: true,
      message: tail || 'Профилировщик не оставил отчёта',
    };
  }

  return {
    profile: parseLineProfile(text),
    stdout: run.stdout,
    stderr: run.stderr,
    failed: false,
    message: null,
  };
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  /** Не пусто — прогон не состоялся (не нашёлся интерпретатор, истёк таймаут). */
  error: string | null;
}

/** Запустить процесс, собирая вывод, и не дать ему висеть дольше предела. */
function spawnProfile(
  python: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let settled = false;
    const child = spawn(python, [...args], { cwd, env, windowsHide: true });
    const finish = (result: SpawnResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({
        stdout: out.slice(-MAX_OUTPUT),
        stderr: err.slice(-MAX_OUTPUT),
        error: 'Профилирование не завершилось вовремя',
      });
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      out = (out + chunk.toString('utf8')).slice(-MAX_OUTPUT);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err = (err + chunk.toString('utf8')).slice(-MAX_OUTPUT);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      finish({ stdout: out, stderr: err, error: `Не удалось запустить интерпретатор: ${messageOf(error)}` });
    });
    child.on('close', () => {
      clearTimeout(timer);
      finish({ stdout: out, stderr: err, error: null });
    });
  });
}

function failedRun(message: string, stdout = '', stderr = ''): LineProfileRun {
  return { profile: parseLineProfile('{}'), stdout, stderr, failed: true, message };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Убрать временный каталог; не вышло — не беда, система почистит свой temp. */
async function cleanup(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
