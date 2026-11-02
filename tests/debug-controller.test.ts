import { describe, expect, it, vi } from 'vitest';
import { DebugController, frameForHover } from '../src/renderer/core/debug';
import { PushTopic, type DebugFrame } from '../src/shared/api';

/**
 * Состояние отладки в окне (`renderer/core/debug.ts`).
 *
 * Панель отладки была покрыта на 2.4%: события из main и точки останова не
 * проверялись вовсе. Здесь проверяется то, что видит человек: какие строки помечены,
 * где остановилась программа, что приходит при выходе из сессии — и правило
 * «одна точка на строку», без которого список точек растёт от каждого клика.
 */

function frame(line: number, path = '/p/a.py'): DebugFrame {
  return {
    id: line,
    name: 'main',
    path,
    line,
    column: 1,
    source: { name: 'a.py', path },
  } as DebugFrame;
}

function makeController() {
  const pushes: ((message: { topic: string; payload: unknown }) => void)[] = [];
  const requests: { method: string; params?: unknown }[] = [];
  const rpc = {
    request: vi.fn(async (method: string, params?: unknown) => {
      requests.push({ method, params });
      return { ok: true, message: 'готово', breakpoints: [] };
    }),
    onPush: (listener: (message: { topic: string; payload: unknown }) => void) => {
      pushes.push(listener);
      return () => {};
    },
    emit: (topic: string, payload: unknown) => {
      for (const listener of pushes) listener({ topic, payload });
    },
  };
  return { controller: new DebugController(rpc as never), rpc, requests };
}

describe('точки останова', () => {
  it('переключение ставит точку на строку', async () => {
    const { controller } = makeController();

    await controller.toggleBreakpoint('/p/a.py', 3);

    expect(controller.linesOf('/p/a.py')).toEqual([3]);
    expect(controller.breakpointsOf('/p/a.py')).toHaveLength(1);
  });

  it('повторное переключение снимает точку', async () => {
    const { controller } = makeController();
    await controller.toggleBreakpoint('/p/a.py', 3);

    await controller.toggleBreakpoint('/p/a.py', 3);

    expect(controller.linesOf('/p/a.py')).toEqual([]);
  });

  it('строки идут по возрастанию, одна точка на строку', async () => {
    // Без этого каждая правка условий плодила бы дубликаты в списке.
    const { controller } = makeController();

    await controller.setBreakpoints('/p/a.py', [{ line: 9 }, { line: 2 }, { line: 9, condition: 'x > 1' }]);

    expect(controller.linesOf('/p/a.py')).toEqual([2, 9]);
    expect(controller.conditionOf('/p/a.py', 9)).toBe('x > 1');
  });

  it('условие из одних пробелов считается пустым', async () => {
    const { controller } = makeController();

    await controller.setBreakpoints('/p/a.py', [{ line: 4, condition: '   ' }]);

    expect(controller.conditionOf('/p/a.py', 4)).toBeNull();
  });

  it('очистка убирает только названные строки', async () => {
    const { controller } = makeController();
    await controller.setBreakpoints('/p/a.py', [{ line: 2 }, { line: 5 }, { line: 8 }]);

    await controller.clearBreakpoints('/p/a.py', [5]);

    expect(controller.linesOf('/p/a.py')).toEqual([2, 8]);
  });

  it('все точки отдаются по файлам', async () => {
    const { controller } = makeController();
    await controller.toggleBreakpoint('/p/a.py', 1);
    await controller.toggleBreakpoint('/p/b.py', 2);

    const all = controller.allBreakpoints();

    expect(all.map(([path]) => path).sort()).toEqual(['/p/a.py', '/p/b.py']);
  });

  it('восстановление берёт точки из настроек', () => {
    const { controller } = makeController();

    controller.restoreBreakpoints([['/p/a.py', [{ line: 7 }]]]);

    expect(controller.linesOf('/p/a.py')).toEqual([7]);
  });
});

describe('события сессии', () => {
  it('останов обновляет фазу, стек и верхний кадр', () => {
    const { controller, rpc } = makeController();

    rpc.emit(PushTopic.DebugStopped, {
      reason: 'breakpoint',
      frames: [frame(3), frame(7)],
    } as never);

    const state = controller.get();
    expect(state.phase).toBe('stopped');
    expect(state.reason).toBe('breakpoint');
    expect(state.frames).toHaveLength(2);
    expect(state.topFrame?.line).toBe(3);
  });

  it('фаза приходит событием состояния: run, затем stopped', () => {
    const { controller, rpc } = makeController();

    rpc.emit(PushTopic.DebugState, { phase: 'run', reason: null, topFrame: null } as never);
    expect(controller.get().phase).toBe('run');

    rpc.emit(PushTopic.DebugState, { phase: 'stopped', reason: null, topFrame: frame(3) } as never);
    expect(controller.get().phase).toBe('stopped');
  });

  it('выход из сессии убирает стек: старые кадры страшнее пустоты', () => {
    // Кадры без сессии означают, что человек смотрит на уже не существующий стек.
    const { controller, rpc } = makeController();
    rpc.emit(PushTopic.DebugStopped, { reason: 'step', frames: [frame(3)] } as never);

    rpc.emit(PushTopic.DebugState, { phase: 'idle', reason: null, topFrame: null } as never);

    const state = controller.get();
    expect(state.phase).toBe('idle');
    expect(state.topFrame).toBeNull();
  });

  it('подписчики слышат каждое изменение', () => {
    const { controller, rpc } = makeController();
    const seen = vi.fn();
    controller.onDidChange(seen);

    rpc.emit(PushTopic.DebugState, { phase: 'run', reason: null, topFrame: null } as never);

    expect(seen).toHaveBeenCalled();
  });

  it('вывод программы доходит до подписчика потока', () => {
    const { controller, rpc } = makeController();
    const output: string[] = [];
    controller.onOutput((payload) => output.push(payload.text));

    rpc.emit(PushTopic.DebugOutput, { text: 'печать\n', category: 'stdout' } as never);

    expect(output.join('')).toBe('печать\n');
  });
});

describe('кадр под указателем', () => {
  it('находит кадр своего файла и строки', () => {
    const frames = [frame(3), frame(7, '/p/b.py')];

    expect(frameForHover(frames, { path: '/p/b.py', line: 7 })?.line).toBe(7);
  });

  it('нет кадра на этой строке — отдаётся верхний кадр', () => {
    // Задумано так: при отладке значения почти всегда нужны из верхнего кадра, и
    // пустой подсказке человек предпочтёт ближайшую.
    expect(frameForHover([frame(3)], { path: '/p/other.py', line: 9 })?.line).toBe(3);
  });

  it('кадров нет — подсказки нет', () => {
    expect(frameForHover([], { path: '/p/a.py', line: 3 })).toBeNull();
  });
});
