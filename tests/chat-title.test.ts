import { describe, expect, it } from 'vitest';
import {
  buildTitlePrompt,
  CHAT_TITLE_MAX_CHARS,
  CHAT_TITLE_SOURCE_MAX_CHARS,
  cleanChatTitle,
  isAutoTitle,
  titleFromQuestion,
} from '../src/shared/chat-title';

/**
 * Название беседы от модели.
 *
 * Две вещи, от которых зависит, станет ли лучше: ответ модели должен стать
 * подписью вкладки как есть (без кавычек, «Тема:» и markdown — иначе они попадут
 * в полосу вкладок), и заголовок, уже данный моделью, нельзя перезаписывать.
 */

describe('cleanChatTitle', () => {
  it('снимает кавычки и оформление', () => {
    expect(cleanChatTitle('«Починка сборки на macOS»')).toBe('Починка сборки на macOS');
    expect(cleanChatTitle('"Починка сборки"')).toBe('Починка сборки');
    expect(cleanChatTitle('**Починка сборки**')).toBe('Починка сборки');
  });

  it('убирает служебное начало и хвост-точку', () => {
    expect(cleanChatTitle('Тема: Починка сборки.')).toBe('Починка сборки');
    expect(cleanChatTitle('Название беседы: Разбор тестов')).toBe('Разбор тестов');
  });

  it('берёт первую строку: пояснение в подписи не нужно', () => {
    expect(cleanChatTitle('Сборка на macOS\n\nЗдесь обсуждали ошибку линковки')).toBe('Сборка на macOS');
  });

  it('снимает markdown-ограждение', () => {
    expect(cleanChatTitle('```\nСборка на macOS\n```')).toBe('Сборка на macOS');
  });

  it('схлопывает пробелы и обрезает по потолку', () => {
    expect(cleanChatTitle('  сборка   на\n macOS ')).toBe('сборка на macOS');
    const long = cleanChatTitle('я'.repeat(200));
    expect(long.length).toBeLessThanOrEqual(CHAT_TITLE_MAX_CHARS);
    expect(long.endsWith('…')).toBe(true);
  });

  it('пустой ответ остаётся пустым — названия нет', () => {
    expect(cleanChatTitle('')).toBe('');
    expect(cleanChatTitle('   \n  ')).toBe('');
    expect(cleanChatTitle('Тема:')).toBe('');
  });
});

describe('buildTitlePrompt', () => {
  it('кладёт вопрос и ответ рядом', () => {
    const text = buildTitlePrompt({ question: 'как собрать?', answer: 'через npm run build' });
    expect(text).toContain('Вопрос: как собрать?');
    expect(text).toContain('Ответ: через npm run build');
  });

  it('обрезает длинные куски: название делают по сути, а не по всему ответу', () => {
    const text = buildTitlePrompt({ question: 'в'.repeat(CHAT_TITLE_SOURCE_MAX_CHARS * 2), answer: 'о' });
    expect(text).toContain('(обрезано)');
    expect(text.length).toBeLessThan(CHAT_TITLE_SOURCE_MAX_CHARS * 2 + 200);
  });
});

describe('isAutoTitle', () => {
  it('заголовок по первому вопросу считается автоматическим', () => {
    const question = 'проверь, что тут сломалось в сборке на маке';
    expect(isAutoTitle(titleFromQuestion(question), question)).toBe(true);
  });

  it('название от модели автоматическим не считается', () => {
    const question = 'проверь, что тут сломалось в сборке на маке';
    expect(isAutoTitle('Сборка падает на macOS', question)).toBe(false);
  });

  it('пустой вопрос даёт «Новая беседа» — её тоже можно заменить', () => {
    expect(isAutoTitle('Новая беседа', '')).toBe(true);
  });
});
