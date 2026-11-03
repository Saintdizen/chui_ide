import { describe, expect, it } from 'vitest';
import { InterjectQueue } from '../src/main/ai/interject';

/**
 * Сказанное на ходу — очередь для идущего прогона.
 *
 * Отличается от очереди панели (`chat-queue.ts`) тем, что попадает внутрь прогона:
 * реплика доезжает до модели на границе ближайшего шага, а не после ответа.
 * Опасное место одно: реплика, пережившая свой прогон, прозвучит в следующем —
 * там, где её никто не говорил. Все проверки ниже — про это.
 */

function listening(): InterjectQueue {
  const queue = new InterjectQueue();
  queue.open();
  return queue;
}

describe('InterjectQueue', () => {
  it('прогон не идёт — реплику не принимают', () => {
    const queue = new InterjectQueue();
    expect(queue.push('стой, не туда')).toBe(false);
    expect(queue.size).toBe(0);
  });

  it('прогон идёт — реплика ждёт границы шага', () => {
    const queue = listening();
    expect(queue.push('стой, не туда')).toBe(true);
    expect(queue.size).toBe(1);
    expect(queue.takeAll()).toEqual(['стой, не туда']);
    // Забрали — очередь пуста: второй раз то же самое к модели не уйдёт.
    expect(queue.takeAll()).toEqual([]);
  });

  it('несколько реплик едут одной пачкой в порядке сказанного', () => {
    const queue = listening();
    queue.push('сначала это');
    queue.push('потом это');
    expect(queue.takeAll()).toEqual(['сначала это', 'потом это']);
  });

  it('пустое и пробельное не принимается', () => {
    const queue = listening();
    expect(queue.push('   \n ')).toBe(false);
    expect(queue.size).toBe(0);
  });

  it('пробелы по краям срезаются', () => {
    const queue = listening();
    queue.push('  проверь тесты  ');
    expect(queue.takeAll()).toEqual(['проверь тесты']);
  });

  it('прогон кончился — сказанное ему не доживает до следующего', () => {
    const queue = listening();
    queue.push('это старому прогону');
    queue.close();
    expect(queue.size).toBe(0);
    expect(queue.takeAll()).toEqual([]);
    // И в новом это не всплывёт: закрытие — не пауза, а забвение.
    queue.open();
    expect(queue.takeAll()).toEqual([]);
  });

  it('новый прогон начинается с пустой очереди', () => {
    const queue = listening();
    queue.push('первому');
    queue.open();
    expect(queue.size).toBe(0);
  });
});
