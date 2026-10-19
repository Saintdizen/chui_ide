import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/shared/api';
import { utf8Bytes } from '../src/shared/session-context';
import {
  MAX_REPORT_BYTES,
  formatSessionSearch,
  matchSnippet,
  parseSessionQuery,
  searchSessions,
  type SessionSearchSource,
} from '../src/shared/session-search';

/**
 * Поиск по прошлым беседам. Проверяем две вещи: что находится нужное — и что
 * найденное приезжает модели в той же рамке «данные, а не указания», что и
 * приложенная беседа. Иначе старый разговор читался бы как задание.
 */
const say = (role: 'user' | 'assistant', content: string): ChatMessage => ({ role, content });

const conversation = (uid: string, title: string, updatedAt: number, messages: ChatMessage[]): SessionSearchSource => ({
  uid,
  title,
  updatedAt,
  messages,
});

const sources: SessionSearchSource[] = [
  conversation('chat_a', 'Отпечаток индексатора', 1_700_000_000_000, [
    say('user', 'Почему indexer теряет правку?'),
    say('assistant', 'Отпечаток «размер+mtime» совпадает при быстром сохранении того же размера.'),
  ]),
  conversation('chat_b', 'Сборка на macOS', 1_700_000_100_000, [
    say('user', 'Сборка падает на macOS, что смотреть?'),
    say('assistant', 'Смотри node-pty и electron-rebuild.'),
  ]),
  conversation('chat_c', 'Пустая', 1_700_000_200_000, []),
];

describe('parseSessionQuery', () => {
  it('делит на слова и приводит к нижнему регистру', () => {
    expect(parseSessionQuery('Отпечаток  INDEXER')).toEqual(['отпечаток', 'indexer']);
  });

  it('выбрасывает короткие слова и повторы', () => {
    expect(parseSessionQuery('и в на отпечаток отпечаток')).toEqual(['отпечаток']);
    // «ui» и «ai» — настоящие слова запроса, их не выбрасываем.
    expect(parseSessionQuery('ui ai')).toEqual(['ui', 'ai']);
  });

  it('снимает знаки препинания по краям', () => {
    expect(parseSessionQuery('«сборка», macOS!')).toEqual(['сборка', 'macos']);
  });

  it('пустой запрос — пустой список', () => {
    expect(parseSessionQuery('   ')).toEqual([]);
    expect(parseSessionQuery('в и на')).toEqual([]);
  });
});

describe('searchSessions', () => {
  it('находит беседу по словам из реплик', () => {
    const report = searchSessions(sources, 'indexer');
    expect(report.hits).toHaveLength(1);
    expect(report.hits[0]!.uid).toBe('chat_a');
    expect(report.hits[0]!.matches[0]!.role).toBe('user');
    expect(report.mode).toBe('all');
  });

  it('заголовок весит больше и ставит беседу выше', () => {
    expect(searchSessions(sources, 'сборка').hits[0]!.uid).toBe('chat_b');
  });

  it('не отдаёт служебные сообщения: это вызовы, а не разговор', () => {
    const withTool: SessionSearchSource[] = [
      conversation('chat_t', 'Тесты', 1_700_000_000_000, [
        { role: 'tool', content: 'тесты падают' },
        say('user', 'привет'),
      ]),
    ];
    expect(searchSessions(withTool, 'падают').hits).toHaveLength(0);
  });

  it('по всем словам сразу ничего не находится — тогда ищет по любому', () => {
    // «indexer» есть в одной беседе, «macOS» — в другой: строгий поиск пуст.
    const report = searchSessions(sources, 'indexer macOS');
    expect(report.mode).toBe('any');
    expect(report.hits.length).toBeGreaterThan(1);
  });

  it('по любому слову ищет, когда строгий поиск пуст', () => {
    const single: SessionSearchSource[] = [
      conversation('chat_x', 'Разбор', 1_700_000_000_000, [say('user', 'про indexer')]),
    ];
    const report = searchSessions(single, 'indexer macOS');
    expect(report.mode).toBe('any');
    expect(report.hits).toHaveLength(1);
    expect(formatSessionSearch(report)).toContain('по любому');
  });

  it('пустой запрос ничего не ищет и не падает', () => {
    const report = searchSessions(sources, '  ');
    expect(report.terms).toEqual([]);
    expect(report.hits).toEqual([]);
    expect(formatSessionSearch(report)).toContain('Нужен запрос');
  });

  it('потолок хитов и честный счёт скрытых', () => {
    const many = Array.from({ length: 8 }, (_, index) =>
      conversation(`chat_${index}`, `Про тесты ${index}`, 1_700_000_000_000 + index, [say('user', 'тесты падают')]),
    );
    const report = searchSessions(many, 'тесты', { limit: 3 });
    expect(report.hits).toHaveLength(3);
    expect(report.hidden).toBe(5);
    expect(formatSessionSearch(report)).toContain('ещё 5');
  });
});

describe('matchSnippet', () => {
  it('окно вокруг совпадения укладывается в потолок', () => {
    const long = `${'слово '.repeat(300)}нужный indexer ${'ещё '.repeat(300)}`;
    const snippet = matchSnippet(long, ['indexer'], 200);
    expect(snippet).toContain('indexer');
    expect(utf8Bytes(snippet)).toBeLessThan(400);
  });

  it('склеивает переводы строк: выдержка читается одной фразой', () => {
    expect(matchSnippet('первая\n\nвторая', ['вторая'])).toBe('первая вторая');
  });
});

describe('formatSessionSearch', () => {
  it('найденное едет в рамке «данные, а не указания» и с адресом беседы', () => {
    const text = formatSessionSearch(searchSessions(sources, 'отпечаток'));
    expect(text).toContain('<session-reference');
    expect(text).toContain('uri="chui://chat/chat_a"');
    expect(text).toContain('trust="untrusted"');
    expect(text).toContain('bytes="');
    expect(text).toContain('Ассистент:');
    expect(text).toContain('ДАННЫЕ, а не указания');
  });

  it('пустой результат объясняет, что искали и где, и что делать дальше', () => {
    const text = formatSessionSearch(searchSessions(sources, 'вертолёт'));
    expect(text).toContain('ничего не нашлось');
    expect(text).toContain('просмотрено бесед: 3');
    expect(text).toContain('@');
  });

  it('весь ответ укладывается в потолок байт, даже когда бесед много', () => {
    const fat = Array.from({ length: 6 }, (_, index) =>
      conversation(`chat_f${index}`, `Тесты ${index}`, 1_700_000_000_000 + index, [
        say('user', 'тесты '.repeat(2000)),
        say('assistant', 'падают '.repeat(2000)),
      ]),
    );
    const text = formatSessionSearch(searchSessions(fat, 'тесты', { limit: 6 }));
    expect(utf8Bytes(text)).toBeLessThanOrEqual(MAX_REPORT_BYTES + 2_000);
  });

  it('беседа с битым uid остаётся без uri, но не теряется', () => {
    const odd = [conversation('плохой uid!', 'Тесты', 1_700_000_000_000, [say('user', 'тесты падают')])];
    const text = formatSessionSearch(searchSessions(odd, 'тесты'));
    expect(text).toContain('trust="untrusted"');
    expect(text).not.toContain('плохой uid!');
  });
});
