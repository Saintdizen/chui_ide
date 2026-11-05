import { describe, expect, it } from 'vitest';
import { RunControls } from '../src/main/ai/run-controls';

/**
 * Пауза и «сказанное на ходу» принадлежат прогону, а не сервису.
 *
 * Пока прогон один, общая пауза — простота. Со второй беседой — ошибка:
 * жмёшь «пауза» в одной задаче, встаёт другая; сказанное на ходу уезжает
 * не в тот разговор, и человек узнаёт об этом только по реакции модели.
 */

describe('у каждого прогона своя пауза', () => {
  it('пауза одной беседы не трогает другую', () => {
    const runs = new RunControls();
    runs.open('a');
    runs.open('b');

    runs.setPaused('a', true);

    expect(runs.entry('a').pause.isPaused).toBe(true);
    expect(runs.entry('b').pause.isPaused).toBe(false);
  });

  it('пауза ждёт продолжения своей беседы и не просыпается от чужой', async () => {
    const runs = new RunControls();
    const gate = runs.entry('a').pause;
    runs.setPaused('a', true);

    const controller = new AbortController();
    let waited = false;
    const waiting = gate.wait(controller.signal).then((value) => {
      waited = value;
    });

    runs.setPaused('b', false);
    await Promise.resolve();
    expect(waited).toBe(false);

    runs.setPaused('a', false);
    await waiting;
    expect(waited).toBe(true);
  });

  it('пауза, поставленная до старта, переживает открытие прогона', () => {
    const runs = new RunControls();
    runs.setPaused('a', true);
    runs.open('a');
    expect(runs.entry('a').pause.isPaused).toBe(true);
  });
});

describe('сказанное на ходу доходит до своей беседы', () => {
  it('очереди не пересекаются', () => {
    const runs = new RunControls();
    runs.open('a');
    runs.open('b');

    expect(runs.interject('a', 'поправка')).toBe(true);

    expect(runs.pending('a')).toBe(1);
    expect(runs.pending('b')).toBe(0);
    expect(runs.entry('a').interject.takeAll()).toEqual(['поправка']);
    expect(runs.entry('b').interject.takeAll()).toEqual([]);
  });

  it('до старта прогона сказать некому — отказ, а не потеря', () => {
    const runs = new RunControls();
    expect(runs.interject('a', 'некому')).toBe(false);
  });
});

describe('записи не текут', () => {
  it('конец прогона убирает запись и снимает паузу', () => {
    const runs = new RunControls();
    runs.open('a');
    runs.setPaused('a', true);

    runs.close('a');

    // Свежая запись под тем же ключом — уже без паузы.
    expect(runs.entry('a').pause.isPaused).toBe(false);
  });

  it('брошенные прогоны вытесняются старейшими', () => {
    const runs = new RunControls();
    for (let index = 0; index < 20; index += 1) runs.open(`run-${index}`);
    // Пауза на старейшем не должна пережить такую кучу прогонов невесть откуда.
    expect(runs.entry('run-0').pause.isPaused).toBe(false);
    expect(runs.entry('run-19').pause.isPaused).toBe(false);
  });

  it('пустой ключ и null — один и тот же прогон', () => {
    const runs = new RunControls();
    runs.open(null);
    expect(runs.interject(undefined, 'сюда')).toBe(true);
    expect(runs.pending('')).toBe(1);
  });
});
