import { spawn } from 'node:child_process';

/**
 * Запуск внешнего инструмента проекта (линтера, проверялки типов) и его stdout.
 *
 * Одно место на все такие запуски: в Node и Python ветках линтера лежали две
 * копии одного кода, и в обеих не было главного — возможности **оборвать**
 * процесс. Без неё повисший линтер живёт после того, как анализ уже сказал «не
 * успели»: он держит рабочий каталог (на Windows из-за этого падает уборка
 * временной папки с `EBUSY`), греет процессор и может ещё что-то писать. С
 * `AbortSignal` его убивают там, где он стал не нужен.
 *
 * Ошибки запуска не бросаем: для линтера «не запустился» — это пустой вывод, а
 * что это значит, решает вызывающий (`tool: null` — проверять нечем).
 */
export interface ToolRunOptions {
  /** Рабочий каталог: пути к цели считаются от него. */
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Оборвать инструмент: он больше не нужен (потолок времени, закрытие проекта). */
  signal?: AbortSignal | undefined;
}

export function runTool(command: string, args: readonly string[], options: ToolRunOptions): Promise<string> {
  return new Promise((resolve) => {
    // Отменённый до запуска — даже не запускаем.
    if (options.signal?.aborted) {
      resolve('');
      return;
    }
    const child = spawn(command, [...args], { cwd: options.cwd, env: options.env, windowsHide: true });

    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    // Сообщения инструмента о себе самом (трейсбеки, предупреждения) нам не нужны.
    child.stderr.on('data', () => undefined);

    const onAbort = (): void => {
      child.kill();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    // `close` после `kill` приходит штатно, поэтому отписка тут, а не в `kill`.
    const done = (): void => {
      options.signal?.removeEventListener('abort', onAbort);
      resolve(out);
    };
    child.on('error', done);
    child.on('close', done);
  });
}
