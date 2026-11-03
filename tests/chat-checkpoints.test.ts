import { describe, expect, it } from 'vitest';
import {
  CHECKPOINT_LIMIT,
  addCheckpointFile,
  beginCheckpoint,
  hasCheckpoint,
  revertPlan,
  revertPreview,
  revertSummary,
  truncateCheckpoints,
} from '../src/renderer/ui/chat-checkpoints';
import type { ChatSession } from '../src/renderer/ui/chat-session';

/**
 * Чекпойнты: «вернуть всё, как было до этого вопроса».
 *
 * Главное свойство, которое здесь закреплено: второй шаг по тому же файлу НЕ
 * перезатирает снимок первого. Иначе откат вернул бы файл к состоянию между
 * шагами — то есть не откатил бы агента вообще.
 */

const session = (): ChatSession => ({}) as unknown as ChatSession;

const file = (text: string) => ({ existed: true, text });

describe('чекпойнты хода', () => {
  it('не заводит чекпойнт на пустом вопросе', () => {
    const chat = session();
    expect(beginCheckpoint(chat, 0, '   ')).toBeUndefined();
    expect(chat.checkpoints ?? []).toHaveLength(0);
  });

  it('заголовок режется до одной короткой строки', () => {
    const chat = session();
    const checkpoint = beginCheckpoint(chat, 3, `перенос\n\nстрок   вопрос ${'длинно '.repeat(20)}`);
    expect(checkpoint?.title.length).toBeLessThanOrEqual(60);
    expect(checkpoint?.title).not.toContain('\n');
  });

  it('второй шаг по тому же файлу не перезатирает снимок первого', () => {
    const chat = session();
    const checkpoint = beginCheckpoint(chat, 0, 'правь a.ts');
    addCheckpointFile(checkpoint, 'a.ts', file('до хода'));
    addCheckpointFile(checkpoint, 'a.ts', file('после первого шага'));
    expect(checkpoint?.files.get('a.ts')?.text).toBe('до хода');
  });

  it('откат на середину берёт самый ранний снимок файла', () => {
    const chat = session();
    const first = beginCheckpoint(chat, 0, 'раз');
    addCheckpointFile(first, 'a.ts', file('v1'));
    addCheckpointFile(first, 'b.ts', file('b1'));
    const second = beginCheckpoint(chat, 2, 'два');
    addCheckpointFile(second, 'a.ts', file('v2'));
    addCheckpointFile(second, 'c.ts', { existed: false, text: '' });

    // Откат к первому ходу — всё назад, файл a.ts именно к v1.
    const plan = revertPlan(chat.checkpoints ?? [], 0);
    expect(plan.get('a.ts')?.text).toBe('v1');
    expect(plan.has('c.ts')).toBe(true);
    // Откат ко второму — трогаем только то, что он менял.
    const tail = revertPlan(chat.checkpoints ?? [], 1);
    expect([...tail.keys()].sort()).toEqual(['a.ts', 'c.ts']);
  });

  it('созданный файл помечается как несуществовавший — его надо убрать', () => {
    const chat = session();
    const checkpoint = beginCheckpoint(chat, 0, 'создай');
    addCheckpointFile(checkpoint, 'new.ts', { existed: false, text: '' });
    expect(revertPlan(chat.checkpoints ?? [], 0).get('new.ts')?.existed).toBe(false);
  });

  it('история ограничена: старое выпадает, новое остаётся', () => {
    const chat = session();
    for (let at = 0; at <= CHECKPOINT_LIMIT; at += 1) beginCheckpoint(chat, at, `вопрос ${at}`);
    const kept = chat.checkpoints ?? [];
    expect(kept).toHaveLength(CHECKPOINT_LIMIT);
    expect(kept[kept.length - 1]?.messageIndex).toBe(CHECKPOINT_LIMIT);
    expect(hasCheckpoint(chat, 0)).toBe(false);
  });

  it('после отката пункты откаченных ходов исчезают', () => {
    const chat = session();
    beginCheckpoint(chat, 0, 'раз');
    beginCheckpoint(chat, 2, 'два');
    truncateCheckpoints(chat, 1);
    expect(chat.checkpoints?.map((item) => item.messageIndex)).toEqual([0]);
  });
});

describe('предосмотр отката', () => {
  const setup = () => {
    const chat = session();
    const first = beginCheckpoint(chat, 0, 'первый вопрос');
    addCheckpointFile(first, 'a.ts', file('v1'));
    addCheckpointFile(first, 'new.ts', { existed: false, text: '' });
    const second = beginCheckpoint(chat, 2, 'второй вопрос');
    addCheckpointFile(second, 'b.ts', file('b1'));
    return chat;
  };

  it('считает файлы и ходы, которые откатятся', () => {
    const preview = revertPreview(setup().checkpoints ?? [], 0);
    expect(preview.files).toBe(3);
    expect(preview.turns).toBe(2);
  });

  it('отличает удаление от возврата: созданное агентом обратно не вернуть', () => {
    const preview = revertPreview(setup().checkpoints ?? [], 0);
    expect(preview.removed).toEqual(['new.ts']);
  });

  it('называет файлы, которые потеряют несохранённое', () => {
    const preview = revertPreview(setup().checkpoints ?? [], 0, ['a.ts', 'чужой.ts']);
    expect(preview.unsaved).toEqual(['a.ts']);
  });

  it('файл, который будет УДАЛЁН, не считается ещё и «потерявшим правки»', () => {
    // Одна и та же потеря, сказанная дважды, читается как две разные беды.
    const preview = revertPreview(setup().checkpoints ?? [], 0, ['new.ts']);
    expect(preview.removed).toEqual(['new.ts']);
    expect(preview.unsaved).toEqual([]);
  });

  it('откат ко второму ходу не трогает файлы первого', () => {
    const preview = revertPreview(setup().checkpoints ?? [], 1);
    expect(preview.files).toBe(1);
    expect(preview.turns).toBe(1);
    expect(preview.unsaved).toEqual([]);
  });

  it('фраза говорит про удаление, а не только про число файлов', () => {
    const preview = revertPreview(setup().checkpoints ?? [], 0);
    const text = revertSummary(preview, 'первый вопрос');
    expect(text).toContain('3');
    expect(text).toContain('УДАЛЕНЫ');
    expect(text).toContain('new.ts');
    expect(text).toContain('первый вопрос');
  });

  it('когда несохранённого нет — про него и не говорит', () => {
    const text = revertSummary(revertPreview(setup().checkpoints ?? [], 0), 'первый вопрос');
    expect(text).not.toContain('несохранённые');
  });

  it('единственное число не превращается в «1 файла»', () => {
    const text = revertSummary(revertPreview(setup().checkpoints ?? [], 1), 'второй вопрос');
    expect(text).toContain('1 файл');
    expect(text).not.toContain('1 файла');
  });

  it('файлы не менялись — говорит про беседу, а не про «0 файлов»', () => {
    const text = revertSummary(revertPreview([], 0), 'вопрос');
    expect(text).not.toContain('0 файл');
    expect(text).toContain('только беседа');
  });

  it('склоняет по-русски, а не пишет «2 файла/файлов»', () => {
    const chat = session();
    for (const path of ['a', 'b', 'c', 'd', 'e']) {
      const checkpoint = beginCheckpoint(chat, 0, `ход ${path}`);
      addCheckpointFile(checkpoint, `${path}.ts`, file('x'));
    }
    // Пять файлов, пять ходов — оба слова во множественном «многом».
    const many = revertSummary(revertPreview(chat.checkpoints ?? [], 0), 'вопрос');
    expect(many).toContain('5 файлов');
    expect(many).not.toContain('/');
    expect(many).toContain('5 ходов');
  });

  it('два и три — «файла», одиннадцать — «файлов»', () => {
    const cases: Array<[number, string]> = [
      [1, '1 файл'],
      [2, '2 файла'],
      [3, '3 файла'],
      [4, '4 файла'],
      [5, '5 файлов'],
      [11, '11 файлов'],
      [21, '21 файл'],
    ];
    for (const [count, expected] of cases) {
      const chat = session();
      const checkpoint = beginCheckpoint(chat, 0, 'ход');
      for (let i = 0; i < count; i += 1) addCheckpointFile(checkpoint, `f${i}.ts`, file('x'));
      expect(revertSummary(revertPreview(chat.checkpoints ?? [], 0), 'вопрос')).toContain(expected);
    }
  });

  it('ветвление: откат к СРЕДНЕМУ ходу оставляет прежние снимки и рубит брошенные', () => {
    const chat = session();
    const first = beginCheckpoint(chat, 0, 'первый');
    addCheckpointFile(first, 'a.ts', file('v1'));
    const second = beginCheckpoint(chat, 2, 'второй');
    addCheckpointFile(second, 'b.ts', file('b1'));
    const third = beginCheckpoint(chat, 4, 'ушедшая ветка');
    addCheckpointFile(third, 'c.ts', file('c1'));

    // Откат ко второму ходу: он сам и всё после отбрасывается, первый остаётся.
    const at = (chat.checkpoints ?? []).findIndex((item) => item.messageIndex === 2);
    truncateCheckpoints(chat, at);
    expect(chat.checkpoints).toHaveLength(1);
    expect([...revertPlan(chat.checkpoints ?? [], 0).keys()]).toEqual(['a.ts']);

    // Пошли другой дорогой: новый ход встаёт на то же место ветки, снимков
    // брошенной дороги он не видит — иначе откат вернул бы файлы, которых нет.
    const другой = beginCheckpoint(chat, 2, 'другая ветка');
    addCheckpointFile(другой, 'd.ts', file('d1'));
    expect([...revertPlan(chat.checkpoints ?? [], 0).keys()].sort()).toEqual(['a.ts', 'd.ts']);
  });

  it('повторный откат к тому же ходу возможен: его снимок не съеден', () => {
    const chat = session();
    const first = beginCheckpoint(chat, 0, 'первый');
    addCheckpointFile(first, 'a.ts', file('v1'));
    const second = beginCheckpoint(chat, 2, 'второй');
    addCheckpointFile(second, 'b.ts', file('b1'));
    // Откат ко ВТОРОМУ ходу: первый и его снимок остаются в беседе.
    truncateCheckpoints(chat, 1);
    expect(hasCheckpoint(chat, 0)).toBe(true);
    expect(revertPlan(chat.checkpoints ?? [], 0).has('a.ts')).toBe(true);
  });
});
