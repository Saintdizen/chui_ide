import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/shared/api';
import {
  formatSessionContext,
  MAX_SESSION_CHARS,
  MAX_SESSION_MESSAGES,
  sessionAttachment,
} from '../src/shared/session-context';

/**
 * Беседа как контекст.
 *
 * Проверяем три свойства, от которых зависит, поможет ли такое вложение или
 * навредит: рамка отделяет чужой разговор от текущего задания, в контекст уходит
 * хвост переписки (а не её начало), и пустая беседа не превращается в чип.
 */

const user = (text: string): ChatMessage => ({ role: 'user', content: text });
const assistant = (text: string): ChatMessage => ({ role: 'assistant', content: text });

describe('formatSessionContext', () => {
  it('оборачивает разговор в рамку «это справка, а не задание»', () => {
    const text = formatSessionContext({
      title: 'Разбор сборки',
      messages: [user('как собрать?'), assistant('вот так')],
    });

    expect(text).toContain('Беседа «Разбор сборки»');
    expect(text).toContain('справка, а не как задание');
    expect(text).toContain('Пользователь: как собрать?');
    expect(text).toContain('Ассистент: вот так');
  });

  it('служебные сообщения инструментов в справку не попадают', () => {
    // Результаты вызовов — это шум, а не разговор: модели они ничего не объясняют.
    const text = formatSessionContext({
      title: 'x',
      messages: [user('вопрос'), { role: 'tool', content: '{"ok":true}', name: 'read_file' }, assistant('ответ')],
    });

    expect(text).not.toContain('read_file');
    expect(text).toContain('Ассистент: ответ');
  });

  it('берёт хвост переписки: в конце обычно итог', () => {
    const messages = Array.from({ length: MAX_SESSION_MESSAGES + 10 }, (_, index) =>
      index % 2 === 0 ? user(`вопрос ${index}`) : assistant(`ответ ${index}`),
    );
    const text = formatSessionContext({ title: 'длинная', messages });

    expect(text).toContain(`вопрос ${MAX_SESSION_MESSAGES + 8}`);
    expect(text).not.toContain('вопрос 0:');
    expect(text).toContain(`Показаны последние ${MAX_SESSION_MESSAGES}`);
  });

  it('общий потолок держит контекст под контролем', () => {
    // Длинные реплики набирают бюджет; хвост, который не влез, помечается.
    const messages = Array.from({ length: 10 }, () => assistant('я'.repeat(4000)));
    const text = formatSessionContext({ title: 'жирная', messages });

    expect((text ?? '').length).toBeLessThan(MAX_SESSION_CHARS + 600);
    expect(text).toContain('дальше не показано');
  });

  it('пустая беседа — null, а не пустая рамка', () => {
    expect(formatSessionContext({ title: 'пустая', messages: [] })).toBeNull();
    expect(formatSessionContext({ title: 'из служебных', messages: [{ role: 'tool', content: 'ok' }] })).toBeNull();
  });
});

describe('sessionAttachment', () => {
  it('чип подписан названием беседы и отмечен видом «session»', () => {
    const item = sessionAttachment({ title: 'Настройка CI', messages: [user('привет')] });

    expect(item?.kind).toBe('session');
    expect(item?.label).toBe('беседа «Настройка CI»');
    expect(item?.title).toBe('Беседа «Настройка CI»');
    // Текст тот же, что у рамки: одно место сборки, чтобы не разъехались.
    expect(item?.text).toBe(formatSessionContext({ title: 'Настройка CI', messages: [user('привет')] }));
  });

  it('длинное название режется в подписи чипа', () => {
    // В панели на 400 px длинный заголовок вытеснил бы остальные чипы.
    const item = sessionAttachment({ title: 'очень длинное название беседы '.repeat(4), messages: [user('x')] });
    expect((item?.label ?? '').length).toBeLessThan(60);
    expect(item?.title.endsWith('»')).toBe(true);
  });
});
