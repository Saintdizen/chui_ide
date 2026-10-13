import { describe, expect, it } from 'vitest';
import { toDocumentLinks, targetFromResolvedLink } from '../src/shared/lsp-document-links';

/**
 * Разбор ссылок в коде (`textDocument/documentLink`). Проверяем и перевод координат
 * (сервер шлёт 0-based, редактор ждёт 1-based), и то, что ссылка без адреса остаётся
 * живой: её доводит `documentLink/resolve`.
 */

const link = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  range: { start: { line: 2, character: 8 }, end: { line: 2, character: 20 } },
  target: 'file:///proj/util.ts',
  ...over,
});

describe('toDocumentLinks', () => {
  it('переводит участок в 1-based и берёт адрес', () => {
    const [entry] = toDocumentLinks([link({ tooltip: 'Открыть util.ts' })]);

    expect(entry).toMatchObject({ line: 3, startColumn: 9, endColumn: 21, target: 'file:///proj/util.ts' });
    expect(entry!.tooltip).toBe('Открыть util.ts');
    expect(entry!.source).toBeDefined();
  });

  it('ссылка без адреса сохраняется: её доведёт resolve', () => {
    const [entry] = toDocumentLinks([link({ target: undefined })]);

    expect(entry!.target).toBeUndefined();
    expect(entry!.source).toBeDefined();
  });

  it('участок нулевой длины и битые записи отбрасываются', () => {
    const empty = link({ range: { start: { line: 2, character: 8 }, end: { line: 2, character: 8 } } });
    expect(toDocumentLinks([empty])).toEqual([]);
    expect(toDocumentLinks([null, {}, { range: {} }])).toEqual([]);
  });

  it('многострочный участок отбрасывается: таких ссылок не бывает', () => {
    const multi = link({ range: { start: { line: 2, character: 8 }, end: { line: 3, character: 4 } } });

    expect(toDocumentLinks([multi])).toEqual([]);
  });

  it('не-массив — пустой список', () => {
    expect(toDocumentLinks(null)).toEqual([]);
    expect(toDocumentLinks({} as unknown)).toEqual([]);
  });
});

describe('targetFromResolvedLink', () => {
  it('берёт адрес из ответа resolve', () => {
    expect(targetFromResolvedLink({ target: 'https://example.com' })).toBe('https://example.com');
  });

  it('пусто или мусор — null: показывать нечего', () => {
    expect(targetFromResolvedLink({})).toBeNull();
    expect(targetFromResolvedLink({ target: '' })).toBeNull();
    expect(targetFromResolvedLink(null)).toBeNull();
  });
});
