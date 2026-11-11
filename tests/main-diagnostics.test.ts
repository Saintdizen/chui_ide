import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Обработчики сбоев main.
 *
 * Проверяются здесь, а не глазами: поведение зависит от порядка событий
 * (`quitting` до `asked`) и от того, кто именно сообщил — main, renderer или
 * подсобный процесс. На живом падении это не воспроизводить.
 */

const listeners = new Map<string, (...args: never[]) => void>();
const boxResponses: number[] = [];
const relaunched = vi.fn();
const exited = vi.fn();

vi.mock('electron', () => ({
  app: {
    getPath: () => os.tmpdir(),
    on: (event: string, fn: (...args: never[]) => void) => listeners.set(event, fn),
    relaunch: () => relaunched(),
    exit: () => exited(),
  },
  dialog: {
    showMessageBox: async () => ({ response: boxResponses.shift() ?? 0 }),
  },
}));

const { appendDiagnostic, diagnosticsLogPath, installDiagnostics } = await import('../src/main/diagnostics');

type Entry = Parameters<typeof appendDiagnostic>[1];

const dirs: string[] = [];

function tempLog(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chui-diag-'));
  dirs.push(dir);
  return path.join(dir, 'logs', 'diagnostics.log');
}

/** Обработчики вешаются на process и app глобально — снимаем за собой. */
const processListeners: [string, NodeJS.SignalsListener][] = [];
const realOn = process.on.bind(process);

function captureProcessOn(): void {
  process.on = ((event: string, fn: NodeJS.SignalsListener) => {
    processListeners.push([event, fn]);
    return process;
  }) as typeof process.on;
}

function restoreProcessOn(): void {
  process.on = realOn;
  for (const [event, fn] of processListeners.splice(0)) process.removeListener(event, fn);
}

afterEach(() => {
  restoreProcessOn();
  listeners.clear();
  boxResponses.length = 0;
  relaunched.mockClear();
  exited.mockClear();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function readLog(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function installAt(file: string): void {
  captureProcessOn();
  installDiagnostics({ logFile: file });
}

function entry(over: Partial<Entry> = {}): Entry {
  return { source: 'main/test', message: 'сломалось', details: [], at: new Date('2026-01-01T00:00:00Z'), ...over };
}

describe('diagnosticsLogPath', () => {
  it('журнал лежит рядом с settings.json, в подкаталоге logs', () => {
    expect(diagnosticsLogPath()).toBe(path.join(os.tmpdir(), 'logs', 'diagnostics.log'));
  });
});

describe('appendDiagnostic', () => {
  it('создаёт каталог и дописывает запись с пустой строкой между ними', () => {
    const file = path.join(tempLog());
    appendDiagnostic(file, entry({ message: 'первый' }));
    appendDiagnostic(file, entry({ message: 'второй' }));
    const log = readLog(file);
    expect(log).toContain('первый');
    expect(log).toContain('второй');
    expect(log.endsWith('\n\n')).toBe(true);
  });

  it('недоступный для записи путь не бросает: журнал — не причина второго сбоя', () => {
    // Файл вместо каталога: mkdirSync упрётся в него.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chui-diag-'));
    dirs.push(dir);
    const blocker = path.join(dir, 'file');
    fs.writeFileSync(blocker, 'x');
    expect(() => appendDiagnostic(path.join(blocker, 'diagnostics.log'), entry())).not.toThrow();
  });
});

describe('installDiagnostics: uncaughtException', () => {
  it('пишет в журнал и спрашивает о перезапуске', async () => {
    const file = tempLog();
    installAt(file);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    boxResponses.push(0);
    const handler = processListeners.find(([e]) => e === 'uncaughtException')?.[1];
    handler?.(new Error('упало') as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(readLog(file)).toContain('упало');
  });

  it('согласие на перезапуск поднимает приложение', async () => {
    const file = tempLog();
    installAt(file);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    boxResponses.push(1);
    processListeners.find(([e]) => e === 'uncaughtException')?.[1]?.(new Error('упало') as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(relaunched).toHaveBeenCalledOnce();
    expect(exited).toHaveBeenCalledOnce();
  });

  it('второй сбой не поднимает второй диалог', async () => {
    const file = tempLog();
    installAt(file);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    boxResponses.push(0, 1);
    const handler = processListeners.find(([e]) => e === 'uncaughtException')?.[1];
    handler?.(new Error('раз') as never);
    handler?.(new Error('два') as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(boxResponses).toHaveLength(1);
    expect(readLog(file)).toContain('два');
  });

  it('после before-quit не спрашивает: окна закрываются штатно', async () => {
    const file = tempLog();
    installAt(file);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    // Нарочно кладём «согласие» в очередь: если бы диалог был задан,
    // `showMessageBox` его бы съел — и лишний вызов `relaunched` выдал бы
    // ошибку. Пустая очередь после прогона и есть проверка «не спросили».
    boxResponses.push(1);
    listeners.get('before-quit')?.(undefined as never);
    processListeners.find(([e]) => e === 'uncaughtException')?.[1]?.(new Error('при выходе') as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(boxResponses).toEqual([1]);
    expect(relaunched).not.toHaveBeenCalled();
    expect(readLog(file)).toContain('при выходе');
  });

  it('недоступный диалог не роняет обработчик — остаётся журнал', async () => {
    const file = tempLog();
    installAt(file);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const handler = processListeners.find(([e]) => e === 'uncaughtException')?.[1];
    expect(() => handler?.(new Error('рано') as never)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(readLog(file)).toContain('рано');
  });
});

describe('installDiagnostics: unhandledRejection', () => {
  it('отказ промиса разбирается так же, как исключение', async () => {
    const file = tempLog();
    installAt(file);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    boxResponses.push(0);
    processListeners.find(([e]) => e === 'unhandledRejection')?.[1]?.('обещание не сдержали' as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(readLog(file)).toContain('обещание не сдержали');
  });
});

describe('installDiagnostics: render-process-gone', () => {
  it('тихий выход renderer не тревожит журнал', () => {
    const file = tempLog();
    installAt(file);
    listeners.get('render-process-gone')?.(
      undefined as never,
      { isDestroyed: () => false } as never,
      {
        reason: 'clean-exit',
        exitCode: 0,
      } as never,
    );
    expect(readLog(file)).toBe('');
  });

  it('авария renderer пишется с причиной и кодом', () => {
    const file = tempLog();
    installAt(file);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    boxResponses.push(0);
    listeners.get('render-process-gone')?.(
      undefined as never,
      { isDestroyed: () => false } as never,
      {
        reason: 'crashed',
        exitCode: 139,
      } as never,
    );
    const log = readLog(file);
    expect(log).toContain('crashed');
    expect(log).toContain('139');
  });

  it('перезапуск перезагружает содержимое, если оно ещё живо', () => {
    const file = tempLog();
    installAt(file);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    boxResponses.push(1);
    const reload = vi.fn();
    listeners.get('render-process-gone')?.(
      undefined as never,
      { isDestroyed: () => false, reload } as never,
      {
        reason: 'crashed',
        exitCode: 1,
      } as never,
    );
    return new Promise((r) => setTimeout(r, 0)).then(() => expect(reload).toHaveBeenCalledOnce());
  });

  it('уничтоженное содержимое не перезагружается', async () => {
    const file = tempLog();
    installAt(file);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    boxResponses.push(1);
    const reload = vi.fn();
    listeners.get('render-process-gone')?.(
      undefined as never,
      { isDestroyed: () => true, reload } as never,
      {
        reason: 'crashed',
        exitCode: 1,
      } as never,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('installDiagnostics: child-process-gone', () => {
  it('подсобный процесс пишется в журнал, но не спрашивает', async () => {
    const file = tempLog();
    installAt(file);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    boxResponses.push(1);
    listeners.get('child-process-gone')?.(
      undefined as never,
      {
        type: 'GPU',
        reason: 'crashed',
        exitCode: 1,
        serviceName: 'gpu',
      } as never,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(boxResponses).toHaveLength(1);
    expect(readLog(file)).toContain('GPU');
    expect(readLog(file)).toContain('служба: gpu');
  });

  it('без имени службы подробностей нет', () => {
    const file = tempLog();
    installAt(file);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    listeners.get('child-process-gone')?.(
      undefined as never,
      {
        type: 'Utility',
        reason: 'crashed',
        exitCode: 1,
      } as never,
    );
    expect(readLog(file)).not.toContain('служба');
  });
});
