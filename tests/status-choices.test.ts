import { describe, expect, it } from 'vitest';
import {
  indentAfterChoice,
  isStatusChoice,
  normalizeEncoding,
  statusChoices,
  statusLanguageLabel,
} from '../src/renderer/core/status-choices';

const base = { language: 'typescript', encoding: 'UTF-8', tabSize: 2, useTabs: false };

describe('statusChoices: что предложить кликом по слоту', () => {
  it('отступы: отмечен тот, что стоит сейчас', () => {
    const items = statusChoices('indent', base);
    expect(items.filter((item) => item.checked).map((item) => item.id)).toEqual(['2-spaces']);
    // Табуляция всегда в списке: иначе из неё некуда вернуться.
    expect(items.some((item) => item.id === 'tab')).toBe(true);
  });

  it('табуляция перебивает размер: отмечен ровно один пункт', () => {
    const items = statusChoices('indent', { ...base, useTabs: true });
    expect(items.filter((item) => item.checked).map((item) => item.id)).toEqual(['tab']);
  });

  it('языки: текущий отмечен, чужие нет', () => {
    const items = statusChoices('language', base);
    expect(items.find((item) => item.id === 'typescript')?.checked).toBe(true);
    expect(items.filter((item) => item.checked)).toHaveLength(1);
  });

  it('кодировка: «UTF-8» в любом написании попадает в отмеченный пункт', () => {
    // В документ она приходит как угодно: `utf8`, `UTF-8`. Список должен это узнать,
    // иначе человек видит список без единой галочки и не понимает, где он.
    for (const spelling of ['UTF-8', 'utf8', 'utf_8']) {
      const items = statusChoices('encoding', { ...base, encoding: spelling });
      expect(items.filter((item) => item.checked).map((item) => item.id)).toEqual(['utf-8']);
    }
  });
});

describe('isStatusChoice: чужой id не применяем', () => {
  it('пустой и выдуманный id — мимо', () => {
    expect(isStatusChoice('indent', '')).toBe(false);
    expect(isStatusChoice('indent', '3-spaces')).toBe(false);
    expect(isStatusChoice('language', '')).toBe(false);
    expect(isStatusChoice('language', 'klingon')).toBe(false);
  });

  it('свои id — да', () => {
    expect(isStatusChoice('indent', 'tab')).toBe(true);
    expect(isStatusChoice('indent', '4-spaces')).toBe(true);
    expect(isStatusChoice('language', 'typescript')).toBe(true);
    expect(isStatusChoice('encoding', 'utf-8')).toBe(true);
  });
});

describe('indentAfterChoice: клик по тому же варианту ничего не делает', () => {
  it('тот же отступ — null, а не «переключил на тот же»', () => {
    // Иначе каждое открытие списка и Enter перерисовывало бы весь документ
    // и показывало тост «сделано» там, где ничего не менялось.
    expect(indentAfterChoice('2-spaces', { tabSize: 2, useTabs: false })).toBeNull();
    expect(indentAfterChoice('tab', { tabSize: 2, useTabs: true })).toBeNull();
  });

  it('смена размера и возврат с табуляции', () => {
    expect(indentAfterChoice('4-spaces', { tabSize: 2, useTabs: false })).toEqual({
      tabSize: 4,
      useTabs: false,
    });
    expect(indentAfterChoice('4-spaces', { tabSize: 2, useTabs: true })).toEqual({
      tabSize: 4,
      useTabs: false,
    });
    expect(indentAfterChoice('tab', { tabSize: 2, useTabs: false })).toEqual({
      tabSize: 2,
      useTabs: true,
    });
  });

  it('мусор не меняет ничего', () => {
    expect(indentAfterChoice('', { tabSize: 2, useTabs: false })).toBeNull();
    expect(indentAfterChoice('много', { tabSize: 2, useTabs: false })).toBeNull();
  });
});

describe('normalizeEncoding', () => {
  it('синонимы сводятся к id списка', () => {
    expect(normalizeEncoding('utf8')).toBe('utf-8');
    expect(normalizeEncoding('UTF-8')).toBe('utf-8');
    expect(normalizeEncoding('utf16le')).toBe('utf-16le');
    expect(normalizeEncoding('iso-8859-1')).toBe('latin1');
  });
});

describe('statusLanguageLabel', () => {
  it('нет языка — честный прочерк, а не пустое место', () => {
    expect(statusLanguageLabel(null)).toBe('—');
    expect(statusLanguageLabel('typescript').length).toBeGreaterThan(0);
  });
});
