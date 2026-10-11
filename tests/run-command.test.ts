import { describe, expect, it } from 'vitest';
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, runProcess, runShellCommand } from '../src/main/ai/run-command';

/**
 * Запуск команд: два свойства, от которых зависит, не повесится ли агент и не
 * потеряется ли суть вывода.
 *
 * Первое — есть предел времени: `npm install` в чужом проекте не должен держать
 * шаг вечно. Второе — при обрезке сохраняются НАЧАЛО и КОНЕЦ: в начале видно,
 * что запустилось, в конце — итог, а середина больших логов не нужна.
 *
 * Процессы настоящие, но короткие: `node -e` вместо сборок.
 */

const node = process.execPath;

/** Напечатать строку-маркер начала, много шума и строку-маркер конца. */
const NOISY = [
  'console.log("__HEAD__");',
  'for (let i = 0; i < 20000; i += 1) console.log("шум ".repeat(4) + i);',
  'console.log("__TAIL__");',
].join('\n');

describe('runProcess', () => {
  it('собирает начало и конец вывода, выбрасывая середину', async () => {
    const result = await runProcess(node, ['-e', NOISY], process.cwd());

    expect(result.code).toBe(0);
    expect(result.truncated).toBe(true);
    // Ключевое отличие от обрезки по хвосту: начало на месте.
    expect(result.output.startsWith('__HEAD__')).toBe(true);
    expect(result.output.trimEnd().endsWith('__TAIL__')).toBe(true);
    // Пометка говорит, сколько потеряно — иначе обрывок примут за целый вывод.
    expect(result.output).toMatch(/отброшено символов: \d+/);
  });

  it('короткий вывод отдаётся целиком и без пометок', async () => {
    const result = await runProcess(node, ['-e', 'console.log("привет")'], process.cwd());

    expect(result.truncated).toBe(false);
    expect(result.output.trim()).toBe('привет');
    expect(result.output).not.toContain('отброшено');
  });

  it('превышение предела времени помечает результат', async () => {
    const result = await runProcess(node, ['-e', 'setTimeout(() => console.log("поздно"), 60000)'], process.cwd(), {
      timeoutMs: 700,
    });

    expect(result.timedOut).toBe(true);
    // Убитый по времени процесс не должен оставить код успеха.
    expect(result.code === 0).toBe(false);
  });

  it('отмена сигналом завершает запуск', async () => {
    const controller = new AbortController();
    const started = runProcess(node, ['-e', 'setTimeout(() => console.log("поздно"), 60000)'], process.cwd(), {
      signal: controller.signal,
    });
    controller.abort();
    const result = await started;
    expect(result.timedOut).toBe(false);
    expect(result.code === 0).toBe(false);
  });

  it('предел времени зажимается в разумные рамки', async () => {
    // Не проверить напрямую, но оба края должны отработать без ошибок:
    // слишком маленький — поднимаем до секунды, слишком большой — срезаем.
    const quick = await runProcess(node, ['-e', 'console.log("ok")'], process.cwd(), { timeoutMs: 1 });
    expect(quick.code).toBe(0);

    expect(MAX_TIMEOUT_MS).toBeGreaterThan(DEFAULT_TIMEOUT_MS);
  });
});

describe('runShellCommand', () => {
  it('работает через оболочку: пайпы и перенаправления', async () => {
    const result = await runShellCommand('echo hello | tr a-z A-Z', process.cwd());
    // На Windows нет `tr` и такого синтаксиса пайпа, проверяем только на POSIX.
    if (process.platform === 'win32') return;
    expect(result.output.trim()).toBe('HELLO');
  });

  it('код выхода доезжает как есть', async () => {
    const result = await runShellCommand('exit 3', process.cwd());
    expect(result.code).toBe(3);
  });
});
