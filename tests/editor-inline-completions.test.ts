import { describe, expect, it, vi } from 'vitest';
import {
  InlineCompletions,
  type GhostController,
  type GhostView,
} from '../src/renderer/editor/input/inline-completions';

/** Двойник представления: запоминает, что ему поставили, и умеет ли вернуть пустоту. */
function fakeView(): GhostView & { shown: Array<{ offset: number; text: string }>; cleared: number } {
  const view = {
    shown: [] as Array<{ offset: number; text: string }>,
    cleared: 0,
    setGhostText(offset: number, text: string) {
      view.shown.push({ offset, text });
    },
    clearGhostText() {
      view.cleared += 1;
    },
  };
  return view;
}

/** Двойник контроллера: текст, курсор и список применённых правок. */
function fakeController(
  text: string,
): GhostController & { caret: number; edits: Array<{ start: number; inserted: string }> } {
  const lineStarts: number[] = [0];
  for (let index = 0; index < text.length; index += 1) if (text[index] === '\n') lineStarts.push(index + 1);
  return {
    caret: 0,
    edits: [],
    get bufferRef() {
      return {
        text,
        positionAt(offset: number) {
          let line = lineStarts.length;
          for (let index = 0; index < lineStarts.length; index += 1) {
            if (lineStarts[index]! > offset) {
              line = index;
              break;
            }
          }
          return { line, column: offset - lineStarts[line - 1]! + 1 };
        },
      };
    },
    applyEdit(edit: { start: number; removed: string; inserted: string }) {
      this.edits.push({ start: edit.start, inserted: edit.inserted });
      this.caret = edit.start + edit.inserted.length;
    },
  } as GhostController & { caret: number; edits: Array<{ start: number; inserted: string }> };
}

/** Ручной планировщик задержки: задержка срабатывает по нашей команде, а не по часам. */
function manualSchedule(): {
  schedule: (run: () => void, ms: number) => () => void;
  fire: () => void;
  pending: () => number;
} {
  const timers = new Set<() => void>();
  return {
    schedule: (run) => {
      timers.add(run);
      return () => timers.delete(run);
    },
    fire: () => {
      const now = [...timers];
      timers.clear();
      for (const run of now) run();
    },
    pending: () => timers.size,
  };
}

/** Дождаться ответа асинхронного запроса: пара микрозадач достаточно. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('призрачная подсказка: когда спрашивать', () => {
  it('выключено — запроса нет и призрачного текста тоже', async () => {
    const view = fakeView();
    const controller = fakeController('const a = 1;\n');
    const complete = vi.fn(async () => ' = 2;');
    const clock = manualSchedule();
    const inline = new InlineCompletions(view, controller, {
      enabled: () => false,
      debounceMs: () => 350,
      complete,
      schedule: clock.schedule,
    });

    inline.onChange({ kind: 'text', from: 0 });
    expect(clock.pending()).toBe(0);
    clock.fire();
    await flush();
    expect(complete).not.toHaveBeenCalled();
    expect(inline.isVisible).toBe(false);
  });

  it('включено — после паузы спрашивает и показывает призрачный текст', async () => {
    const view = fakeView();
    const controller = fakeController('const a = 1;\n');
    controller.caret = 11;
    const complete = vi.fn(async () => ' // хвост');
    const clock = manualSchedule();
    const inline = new InlineCompletions(view, controller, {
      enabled: () => true,
      debounceMs: () => 350,
      complete,
      schedule: clock.schedule,
    });

    inline.onChange({ kind: 'text', from: 11 });
    expect(clock.pending()).toBe(1);
    clock.fire();
    await flush();

    expect(complete).toHaveBeenCalledOnce();
    expect(inline.isVisible).toBe(true);
    expect(inline.text).toBe(' // хвост');
    expect(view.shown).toEqual([{ offset: 11, text: ' // хвост' }]);
  });

  it('пустой контекст — не спрашиваем вовсе', async () => {
    const view = fakeView();
    const controller = fakeController('');
    const complete = vi.fn(async () => 'что-то');
    const clock = manualSchedule();
    const inline = new InlineCompletions(view, controller, {
      enabled: () => true,
      debounceMs: () => 350,
      complete,
      schedule: clock.schedule,
    });

    inline.onChange({ kind: 'text', from: 0 });
    clock.fire();
    await flush();
    expect(complete).not.toHaveBeenCalled();
    expect(inline.isVisible).toBe(false);
  });

  it('ответ устарел, раз курсор уехал — не показываем', async () => {
    const view = fakeView();
    const controller = fakeController('const a = 1;\n');
    controller.caret = 5;
    let resolveAnswer: (value: string) => void = () => undefined;
    const complete = vi.fn(() => new Promise<string>((resolve) => (resolveAnswer = resolve)));
    const clock = manualSchedule();
    const inline = new InlineCompletions(view, controller, {
      enabled: () => true,
      debounceMs: () => 350,
      complete,
      schedule: clock.schedule,
    });

    inline.onChange({ kind: 'text', from: 5 });
    clock.fire();
    await flush();
    expect(complete).toHaveBeenCalledOnce();

    // Человек ушёл на другое место, пока ответ был в пути.
    controller.caret = 9;
    inline.onChange({ kind: 'selection', from: 9 });
    resolveAnswer(' // поздно');
    await flush();

    expect(inline.isVisible).toBe(false);
    expect(view.shown).toEqual([]);
  });
});

describe('призрачная подсказка: принятие и снятие', () => {
  /** Слой с готовой видимой подсказкой. */
  async function withSuggestion(): Promise<{
    inline: InlineCompletions;
    view: ReturnType<typeof fakeView>;
    controller: ReturnType<typeof fakeController>;
    clock: ReturnType<typeof manualSchedule>;
    complete: ReturnType<typeof vi.fn>;
  }> {
    const view = fakeView();
    const controller = fakeController('const a = 1;\n');
    controller.caret = 11;
    const complete = vi.fn(async () => ' + 2');
    const clock = manualSchedule();
    const inline = new InlineCompletions(view, controller, {
      enabled: () => true,
      debounceMs: () => 350,
      complete,
      schedule: clock.schedule,
    });
    inline.onChange({ kind: 'text', from: 11 });
    clock.fire();
    await flush();
    return { inline, view, controller, clock, complete };
  }

  it('Tab принимает подсказку и не зовёт новый запрос на своей же правке', async () => {
    const { inline, controller, clock } = await withSuggestion();

    const tab = { key: 'Tab', preventDefault: vi.fn() } as unknown as KeyboardEvent;
    expect(inline.handleKey(tab)).toBe(true);
    expect(controller.edits).toEqual([{ start: 11, inserted: ' + 2' }]);
    expect(inline.isVisible).toBe(false);

    // Правка от принятия приходит откликом: нового запроса она не заводит.
    inline.onChange({ kind: 'text', from: 11 });
    expect(clock.pending()).toBe(0);
    expect(controller.edits).toHaveLength(1);
  });

  it('Shift+Tab не принимает — остаётся снятием отступа', async () => {
    const { inline, controller } = await withSuggestion();
    const event = { key: 'Tab', shiftKey: true, preventDefault: vi.fn() } as unknown as KeyboardEvent;
    expect(inline.handleKey(event)).toBe(false);
    expect(controller.edits).toEqual([]);
  });

  it('Escape убирает подсказку', async () => {
    const { inline, view } = await withSuggestion();
    const escapeKey = { key: 'Escape', preventDefault: vi.fn() } as unknown as KeyboardEvent;
    expect(inline.handleKey(escapeKey)).toBe(true);
    expect(inline.isVisible).toBe(false);
    expect(view.cleared).toBeGreaterThan(0);
  });

  it('без видимой подсказки клавиши уходят редактору', async () => {
    const view = fakeView();
    const controller = fakeController('const a = 1;\n');
    const inline = new InlineCompletions(view, controller, {
      enabled: () => false,
      debounceMs: () => 350,
      complete: async () => null,
      schedule: manualSchedule().schedule,
    });
    expect(inline.handleKey({ key: 'Tab' } as KeyboardEvent)).toBe(false);
    expect(inline.handleKey({ key: 'Escape' } as KeyboardEvent)).toBe(false);
  });

  it('счётчики показывают путь подсказки: запрос → показ → принятие', async () => {
    const { inline } = await withSuggestion();
    inline.handleKey({ key: 'Tab', preventDefault: vi.fn() } as unknown as KeyboardEvent);
    expect(inline.diagnostics).toEqual({ requests: 1, shown: 1, accepts: 1, dismisses: 1 });
  });
});
