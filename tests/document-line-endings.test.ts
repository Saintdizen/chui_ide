import { describe, expect, it } from 'vitest';
import { DocumentStore } from '../src/renderer/core/document-store';

/**
 * Концы строк живут в документе, а не в модели текста.
 *
 * Модель — всегда `\n` (иначе позиции правок и LSP расходятся), но файл на диск надо
 * писать тем же концом, каким он пришёл. Без этого сохранение windows-файла без единой
 * правки переписывало все строки, и `git diff` показывал файл целиком.
 */
describe('TextDocument: концы строк', () => {
  it('формат читается с диска, а текст модели остаётся в LF', () => {
    const store = new DocumentStore();
    const document = store.open('/p/win.cs', 'a\r\nb\r\nc');

    expect(document.lineEnding).toBe('\r\n');
    expect(document.value).toBe('a\nb\nc');
    expect(document.diskText).toBe('a\r\nb\r\nc');
  });

  it('файл в LF пишется обратно в LF — лишние CR не появляются', () => {
    const store = new DocumentStore();
    const document = store.open('/p/unix.ts', 'a\nb\n');

    expect(document.lineEnding).toBe('\n');
    expect(document.diskText).toBe('a\nb\n');
  });

  it('смена формата не переписывает модель: текст остаётся в LF, меняется только запись', () => {
    const store = new DocumentStore();
    const document = store.open('/p/a.ts', 'первая\nвторая\n');

    expect(document.setLineEnding('\r\n')).toBe(true);
    expect(document.lineEnding).toBe('\r\n');
    expect(document.value).toBe('первая\nвторая\n');
    expect(document.diskText).toBe('первая\r\nвторая\r\n');
  });

  it('смена формата не меняет текст модели — и потому не трогает undo и версию', () => {
    const store = new DocumentStore();
    const document = store.open('/p/a.ts', 'строка');
    const before = document.version;

    document.setLineEnding('\r\n');

    // В модели нет ни одного перевода строки, а формат — свойство файла, не текста:
    // будь тут рост версии, LSP-сервер получил бы пустое изменение документа.
    expect(document.version).toBe(before);
    expect(document.value).toBe('строка');
    expect(document.diskText).toBe('строка');
  });

  it('тот же формат второй раз — не правка и не мусор в undo', () => {
    const store = new DocumentStore();
    const document = store.open('/p/a.ts', 'a\nb');
    const before = document.version;

    expect(document.setLineEnding('\n')).toBe(false);
    expect(document.version).toBe(before);
  });

  it('пустой файл: формат по умолчанию LF, а не отказ', () => {
    const store = new DocumentStore();
    const document = store.open('/p/empty.txt', '');

    expect(document.lineEnding).toBe('\n');
    expect(document.diskText).toBe('');
  });
});
