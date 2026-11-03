import { describe, expect, it } from 'vitest';
import {
  CHECKPOINT_LIMIT,
  addCheckpointFile,
  beginCheckpoint,
  hasCheckpoint,
  revertPlan,
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
