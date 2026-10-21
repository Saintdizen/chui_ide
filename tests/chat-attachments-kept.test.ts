import { describe, expect, it } from 'vitest';
import {
  KEPT_MAX_CHARS,
  KEPT_MAX_ITEMS,
  dropAttachment,
  keepLatest,
  keptContextMessage,
  takeSent,
} from '../src/shared/chat-attachments';
import type { ChatAttachment } from '../src/shared/api';

/**
 * Приложенный контекст и сжатие беседы.
 *
 * Резюме пересказывает разговор, но не присланные файлы: без этих правил модель
 * после первого сжатия продолжала бы работу, не видя кода, о котором речь.
 */

const file = (label: string, text = 'const x = 1;'): ChatAttachment =>
  ({
    kind: 'file',
    label,
    title: label,
    text,
  }) as ChatAttachment;

describe('takeSent', () => {
  it('отдаёт вложения, но сам ничего не откладывает', () => {
    // Что переживёт сжатие, решает пометка на чипе, а не факт отправки: иначе
    // файл, про который давно забыли, ездил бы в каждом пересказе.
    const session: { attachments: ChatAttachment[]; kept?: ChatAttachment[] } = {
      attachments: [file('a.ts'), file('b.ts')],
    };
    const sent = takeSent(session);
    expect(sent).toHaveLength(2);
    expect(session.attachments).toEqual([]);
    expect(session.kept).toBeUndefined();
  });

  it('отложенное пометкой отправка не трогает', () => {
    const session = { attachments: [file('new.ts')], kept: [file('old.ts')] };
    takeSent(session);
    expect(session.kept?.map((item) => item.label)).toEqual(['old.ts']);
  });
});

describe('dropAttachment', () => {
  it('снятый до отправки чип не переживает сжатие', () => {
    const session = { kept: [file('a.ts'), file('b.ts')] };
    dropAttachment(session, 'a.ts');
    expect(session.kept?.map((item) => item.label)).toEqual(['b.ts']);
  });

  it('сняли последний — поля не остаётся пустым', () => {
    const session: { kept?: ChatAttachment[] } = { kept: [file('a.ts')] };
    dropAttachment(session, 'a.ts');
    expect(session.kept).toBeUndefined();
  });

  it('чужое имя ничего не ломает', () => {
    const session = { kept: [file('a.ts')] };
    dropAttachment(session, 'нет-такого.ts');
    expect(session.kept).toHaveLength(1);
  });
});

describe('keptContextMessage', () => {
  it('ничего не приложено — сообщения нет', () => {
    expect(keptContextMessage(undefined)).toBeNull();
    expect(keptContextMessage([])).toBeNull();
  });

  it('контекст едет репликой пользователя, а не системной', () => {
    // Всё, что пришло от человека, должно быть видно модели как пришедшее от
    // человека: иначе присланный файл получит вес инструкции.
    const message = keptContextMessage([file('src/a.ts', 'export const a = 1;')]);
    expect(message?.role).toBe('user');
    expect(message?.content).toContain('src/a.ts');
    expect(message?.content).toContain('export const a = 1;');
  });
});

describe('keepLatest', () => {
  it('держит не больше предела штук, отбрасывая старое', () => {
    const many = Array.from({ length: KEPT_MAX_ITEMS + 4 }, (_, index) => file(`f${index}.ts`));
    const kept = keepLatest(many);
    expect(kept).toHaveLength(KEPT_MAX_ITEMS);
    expect(kept.at(-1)?.label).toBe(`f${KEPT_MAX_ITEMS + 3}.ts`);
    // Живёт самое свежее: нулевой файл давно вытеснен.
    expect(kept.some((item) => item.label === 'f0.ts')).toBe(false);
  });

  it('держит бюджет по тексту, но не оставляет пустоту', () => {
    const big = file('big.ts', 'x'.repeat(KEPT_MAX_CHARS));
    expect(keepLatest([big]).map((item) => item.label)).toEqual(['big.ts']);
    const kept = keepLatest([big, file('small.ts')]);
    expect(kept.map((item) => item.label)).toEqual(['small.ts']);
  });
});
