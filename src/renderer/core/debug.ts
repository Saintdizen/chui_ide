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

const IDLE: DebugState = { phase: 'idle', reason: null, frames: [], topFrame: null };

export class DebugController {
  private state: DebugState = IDLE;
  /** Точки останова по файлам. Держим копию, чтобы отправить их при старте. */
  private readonly breakpoints = new Map<string, number[]>();

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

  /** Строки точек останова файла: редактор рисует по ним свои значки. */
  linesOf(path: string): number[] {
    return this.breakpoints.get(path) ?? [];
  }

  /** Включить или выключить точку останова на строке. Возвращает новый набор. */
  async toggleBreakpoint(path: string, line: number): Promise<number[]> {
    const current = new Set(this.breakpoints.get(path) ?? []);
    if (current.has(line)) current.delete(line);
    else current.add(line);
    return this.setBreakpoints(path, [...current]);
  }

  /** Задать точки останова файла: набор заменяется целиком, как в DAP. */
  async setBreakpoints(path: string, lines: readonly number[]): Promise<number[]> {
    const sorted = [...new Set(lines)].sort((a, b) => a - b);
    if (sorted.length === 0) this.breakpoints.delete(path);
    else this.breakpoints.set(path, sorted);
    // main подтверждает строки (он же отправит их отладчику); ошибка — не беда,
    // точки уже сохранены у нас и уедут при старте.
    await this.rpc.request('debug.setBreakpoints', { path, lines: sorted }).catch(() => undefined);
    return sorted;
  }

  /** Запустить отладку файла. Все известные точки main получит по событию `initialized`. */
  async start(program: string, cwd?: string): Promise<{ ok: boolean; message: string }> {
    // Точки всех файлов отправляем заранее: отладчик запросит их при инициализации.
    for (const [path, lines] of this.breakpoints) {
      await this.rpc.request('debug.setBreakpoints', { path, lines }).catch(() => undefined);
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

  private apply(next: DebugState): void {
    this.state = next;
    if (next.phase === 'idle') this.state = { ...next, frames: [], topFrame: null };
    this.emitter.fire(this.state);
  }
}
