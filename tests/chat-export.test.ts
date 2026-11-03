import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/shared/api';
import { chatExportFileName, chatToMarkdown } from '../src/shared/chat-export';

/**
 * Экспорт беседы в Markdown.
 *
 * Модуль чистый — поэтому и проверяется целиком, без окна и RPC. Это важно ещё
 * и потому, что файл уходит человеку БЕЗ этой IDE: ошибку в нём увидят уже там.
 */

const user = (content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ role: 'user', content, ...extra });
const assistant = (content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  role: 'assistant',
  content,
  ...extra,
});

describe('chatToMarkdown', () => {
  it('даёт заголовок, роли и текст в порядке переписки', () => {
    const md = chatToMarkdown([user('как собрать?'), assistant('через npm')], { title: 'Сборка' });

    expect(md).toContain('# Сборка');
    const askAt = md.indexOf('## Вы');
    const answerAt = md.indexOf('## Ассистент');
    expect(askAt).toBeGreaterThan(-1);
    expect(answerAt).toBeGreaterThan(askAt);
    expect(md).toContain('через npm');
  });

  it('дата, модель и папка выводятся, когда есть, и исчезают целиком, когда нет', () => {
    const full = chatToMarkdown([user('a')], {
      title: 'т',
      date: '2026-11-03',
      model: 'gpt-5',
      workspace: '/home/me/proj',
    });
    expect(full).toContain('**Дата:** 2026-11-03');
    expect(full).toContain('**Модель:** gpt-5');
    expect(full).toContain('`/home/me/proj`');

    // Ни одного из полей — и строки про факты нет совсем, а не «Модель: —».
    const bare = chatToMarkdown([user('a')], { title: 'т' });
    expect(bare).not.toContain('**Дата:**');
    expect(bare).not.toContain('**Модель:**');
  });

  it('без заголовка пишет «Беседа», а не «# »', () => {
    const md = chatToMarkdown([user('a')], { title: '   ' });
    expect(md.startsWith('# Беседа')).toBe(true);
  });

  it('пустая беседа — явная пометка, а не пустой файл', () => {
    const md = chatToMarkdown([], { title: 'Пусто' });
    expect(md).toContain('В беседе ещё нет сообщений');
  });

  it('служебный дострой обрезанного ответа не становится вопросом', () => {
    const md = chatToMarkdown([user('Продолжи с того места, где остановился.'), assistant('дальше')], {
      title: 'т',
    });
    expect(md).not.toContain('## Вы');
    expect(md).toContain('дальше');
  });

  it('вызовы инструментов не теряются: это суть агентной беседы', () => {
    const md = chatToMarkdown(
      [user('поправь'), assistant('', { toolCalls: [{ id: '1', name: 'edit_file', arguments: '{"path":"a.ts"}' }] })],
      { title: 'т' },
    );

    expect(md).toContain('edit_file');
    expect(md).toContain('{"path":"a.ts"}');
  });

  it('картинки — ссылками, и их можно выключить', () => {
    const image = 'data:image/png;base64,AAAA';
    const withImage = chatToMarkdown([user('смотри', { images: [image] })], { title: 'т' });
    expect(withImage).toContain(`](${image})`);

    const without = chatToMarkdown([user('смотри', { images: [image] })], { title: 'т' }, { images: false });
    expect(without).not.toContain('base64');
  });

  it('сообщение только с картинкой не теряется', () => {
    const md = chatToMarkdown([user('', { images: ['data:image/png;base64,AAAA'] })], { title: 'т' });
    expect(md).toContain('data:image/png;base64,AAAA');
  });

  it('одинаковый вход — одинаковый файл (нет даты и времени внутри)', () => {
    const messages = [user('a'), assistant('b')];
    expect(chatToMarkdown(messages, { title: 'т' })).toBe(chatToMarkdown(messages, { title: 'т' }));
  });
});

describe('chatExportFileName', () => {
  it('чистит символы, недопустимые в имени файла', () => {
    // Заголовок беседы — первая строка вопроса: в нём запросто окажется `/` или `:`.
    const name = chatExportFileName('Как работает a/b: разбор?');
    expect(name).not.toMatch(/[\\/:*?"<>|]/);
    expect(name.endsWith('.md')).toBe(true);
  });

  it('добавляет дату, если она есть', () => {
    expect(chatExportFileName('беседа', '2026-11-03')).toBe('беседа (2026-11-03).md');
  });

  it('без заголовка даёт имя, а не голое «.md»', () => {
    expect(chatExportFileName('   ')).toBe('Беседа.md');
    expect(chatExportFileName('...')).toBe('Беседа.md');
  });

  it('обрезает длинный заголовок', () => {
    const name = chatExportFileName('а'.repeat(300));
    expect(name.length).toBeLessThanOrEqual(80 + '.md'.length);
  });
});
