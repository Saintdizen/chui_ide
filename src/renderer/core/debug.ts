import {
  PushTopic,
  type DebugFrame,
  type DebugOutputPayload,
  type DebugPhase,
  type DebugScope,
  type DebugStoppedPayload,
  type DebugVariable,
} from '../../shared/api';
import { Emitter } from './events';
import type { RpcClient } from './rpc';

/**
 * Состояние отладки в renderer: точки останова, стек и фаза сессии.
 *
 * Сам отладчик живёт в main (это процесс debugpy), здесь — то, что рисует
 * интерфейс: какие файлы и строки помечены точками, где остановилась программа
 * и что лежит в переменных. События (останов, вывод, смена фазы) приходят push-
 * уведомлениями, поэтому панель не опрашивает main.
 */

/** Наблюдаемое состояние панели: фаза, стек и строка останова. */
export interface DebugState {
  phase: DebugPhase;
  reason: string | null;
  frames: DebugFrame[];
  topFrame: DebugFrame | null;
}

/** Точка останова в том виде, в каком её держит renderer. */
export interface BreakpointInput {
  line: number;
  /** Останавливаться, только если выражение истинно. */
  condition?: string;
  /** Останавливаться после стольких попаданий. */
  hitCondition?: string;
  /** Точка в журнал: печатает сообщение вместо останова. */
  logMessage?: string;
}

const IDLE: DebugState = { phase: 'idle', reason: null, frames: [], topFrame: null };

/**
 * Привести набор к DAP-виду: одна точка на строку, по возрастанию, условие без
 * пробелов по краям. Пустое условие — обычная точка, а не «условие из пробелов».
 */
function normalize(breakpoints: readonly BreakpointInput[]): BreakpointInput[] {
  const byLine = new Map<number, BreakpointInput>();
  for (const item of breakpoints) {
    if (!Number.isInteger(item.line) || item.line < 1) continue;
    const condition = item.condition?.trim();
    const hitCondition = item.hitCondition?.trim();
    // Сообщение не обрезаем: пробелы в нём могут быть частью формата.
    const logMessage = item.logMessage?.length ? item.logMessage : undefined;
    byLine.set(item.line, {
      line: item.line,
      ...(condition ? { condition } : {}),
      ...(hitCondition ? { hitCondition } : {}),
      ...(logMessage ? { logMessage } : {}),
    });
  }
  return [...byLine.values()].sort((a, b) => a.line - b.line);
}

export class DebugController {
  private state: DebugState = IDLE;
  /** Точки останова по файлам. Держим копию, чтобы отправить их при старте. */
  private readonly breakpoints = new Map<string, BreakpointInput[]>();

  private readonly emitter = new Emitter<DebugState>();
  readonly onDidChange = this.emitter.event;

  private readonly outputEmitter = new Emitter<DebugOutputPayload>();
  /** Вывод отлаживаемой программы: панель печатает его в свой лог. */
  readonly onOutput = this.outputEmitter.event;

  constructor(private readonly rpc: RpcClient) {
    rpc.onPush((message) => {
      switch (message.topic) {
        case PushTopic.DebugState: {
          const payload = message.payload as { phase: DebugPhase; reason: string | null; topFrame: DebugFrame | null };
          this.apply({ ...this.state, phase: payload.phase, reason: payload.reason, topFrame: payload.topFrame });
          break;
        }
        case PushTopic.DebugStopped: {
          const payload = message.payload as DebugStoppedPayload;
          this.apply({ phase: 'stopped', reason: payload.reason, frames: payload.frames, topFrame: payload.frames[0] ?? null });
          break;
        }
        case PushTopic.DebugOutput: {
          this.outputEmitter.fire(message.payload as DebugOutputPayload);
          break;
        }
        default:
          break;
      }
    });
  }

  get(): DebugState {
    return this.state;
  }

  /** Точки останова файла: редактор рисует по ним значки, а панель — условия. */
  breakpointsOf(path: string): readonly BreakpointInput[] {
    return this.breakpoints.get(path) ?? [];
  }

  /** Условие точки на строке; null — точки нет или она безусловная. */
  conditionOf(path: string, line: number): string | null {
    return this.breakpoints.get(path)?.find((item) => item.line === line)?.condition ?? null;
  }

  /** Строки точек останова файла — для значков в редакторе. */
  linesOf(path: string): number[] {
    return this.breakpointsOf(path).map((item) => item.line);
  }

  /** Включить точку останова на строке, если её нет, и выключить, если есть. */
  async toggleBreakpoint(path: string, line: number): Promise<BreakpointInput[]> {
    const current = this.breakpointsOf(path).filter((item) => item.line !== line);
    if (current.length === this.linesOf(path).length) current.push({ line });
    return this.setBreakpoints(path, current);
  }

  /** Настройка точки на строке: обновляем её и оставляем точку на месте. */
  async setBreakpointOptions(
    path: string,
    line: number,
    options: { condition?: string; hitCondition?: string; logMessage?: string },
  ): Promise<BreakpointInput[]> {
    const next = this.breakpointsOf(path)
      .filter((item) => item.line !== line)
      .concat([{ line, ...options }])
      .sort((a, b) => a.line - b.line);
    return this.setBreakpoints(path, next);
  }

  /** Убрать точку останова с указанных строк; пустой список — убрать все точки файла. */
  async clearBreakpoints(path: string, lines: readonly number[]): Promise<BreakpointInput[]> {
    const drop = new Set(lines);
    const next = lines.length === 0 ? [] : this.breakpointsOf(path).filter((item) => !drop.has(item.line));
    return this.setBreakpoints(path, next);
  }

  /** Задать точки останова файла: набор заменяется целиком, как в DAP. */
  async setBreakpoints(path: string, breakpoints: readonly BreakpointInput[]): Promise<BreakpointInput[]> {
    const next = normalize(breakpoints);
    if (next.length === 0) this.breakpoints.delete(path);
    else this.breakpoints.set(path, next);
    // main подтверждает точки (он же отправит их отладчику); ошибка — не беда,
    // набор уже сохранён у нас и уедет при старте.
    await this.rpc.request('debug.setBreakpoints', { path, breakpoints: next }).catch(() => undefined);
    return next;
  }

  /** Запустить отладку файла. Все известные точки main получит по событию `initialized`. */
  async start(program: string, cwd?: string): Promise<{ ok: boolean; message: string }> {
    // Точки всех файлов отправляем заранее: отладчик запросит их при инициализации.
    for (const [path, breakpoints] of this.breakpoints) {
      await this.rpc.request('debug.setBreakpoints', { path, breakpoints }).catch(() => undefined);
    }
    return this.rpc.request('debug.start', { program, cwd });
  }

  async resume(): Promise<void> {
    await this.rpc.request('debug.continue').catch(() => undefined);
  }

  async step(kind: 'over' | 'into' | 'out'): Promise<void> {
    await this.rpc.request('debug.step', { kind }).catch(() => undefined);
  }

  async pause(): Promise<void> {
    await this.rpc.request('debug.pause').catch(() => undefined);
  }

  async stop(): Promise<void> {
    await this.rpc.request('debug.stop').catch(() => undefined);
  }

  scopes(frameId: number): Promise<DebugScope[]> {
    return this.rpc.request('debug.scopes', { frameId }).catch(() => []);
  }

  variables(reference: number): Promise<DebugVariable[]> {
    return this.rpc.request('debug.variables', { reference }).catch(() => []);
  }

  /** Вычислить выражение в кадре — для панели «наблюдение». */
  evaluate(expression: string, frameId?: number): Promise<DebugVariable> {
    return this.rpc
      .request('debug.evaluate', { expression, ...(frameId !== undefined ? { frameId } : {}) })
      .catch(() => ({ name: expression, value: 'отладчик недоступен', type: null, variablesReference: 0 }));
  }

  private apply(next: DebugState): void {
    this.state = next;
    if (next.phase === 'idle') this.state = { ...next, frames: [], topFrame: null };
    this.emitter.fire(this.state);
  }
}
