import { describe, expect, it } from 'vitest';

import {
  composerAction,
  composerHint,
  focusAfterCard,
  type ComposerKey,
  type ComposerState,
} from '../src/shared/run-keys';

/**
 * Клавиши прогона в поле ввода.
 *
 * Найдено разбором: стоп, пауза и «продолжить» жили только в кнопках — человек,
 * который в этот момент пишет в поле, бросал клавиатуру и целился мышью, чтобы
 * остановить прогон, тратящий токены. `ai.stop` была, но без сочетания.
 */

const key = (over: Partial<ComposerKey> = {}): ComposerKey => ({
  key: 'Escape',
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...over,
});

const running: ComposerState = { busy: true, paused: false };
const paused: ComposerState = { busy: true, paused: true };
const idle: ComposerState = { busy: false, paused: false };

describe('composerAction: стоп', () => {
  it('Escape останавливает идущий прогон', () => {
    expect(composerAction(key(), running)).toBe('stop');
  });

  it('Escape на паузе тоже останавливает: пауза — не защита от «хватит»', () => {
    expect(composerAction(key(), paused)).toBe('stop');
  });

  it('на пустой беседе Escape не делает ничего', () => {
    // Иначе тихое нажатие выдавало бы «сейчас ничего не генерируется».
    expect(composerAction(key(), idle)).toBe('none');
  });

  it('Escape со сдвигом не стоп: это чужая клавиша', () => {
    expect(composerAction(key({ shiftKey: true }), running)).toBe('none');
  });

  it('Escape с Ctrl не стоп', () => {
    expect(composerAction(key({ ctrlKey: true }), running)).toBe('none');
  });
});

describe('composerAction: пауза и продолжение', () => {
  it('Ctrl+Shift+Space ставит на паузу', () => {
    expect(composerAction(key({ key: ' ', ctrlKey: true, shiftKey: true }), running)).toBe('pause');
  });

  it('на паузе то же сочетание продолжает', () => {
    expect(composerAction(key({ key: ' ', ctrlKey: true, shiftKey: true }), paused)).toBe('resume');
  });

  it('⌘+Shift+Space работает на маке так же', () => {
    expect(composerAction(key({ key: ' ', metaKey: true, shiftKey: true }), running)).toBe('pause');
  });

  it('без Shift это не пауза — Ctrl+Space занят автодополнением', () => {
    expect(composerAction(key({ key: ' ', ctrlKey: true }), running)).toBe('none');
  });

  it('Shift+Space без модификатора — обычный пробел', () => {
    expect(composerAction(key({ key: ' ', shiftKey: true }), running)).toBe('none');
  });

  it('понимает `Space` наравне с пробелом: синтетические события шлют и так', () => {
    expect(composerAction(key({ key: 'Space', ctrlKey: true, shiftKey: true }), running)).toBe('pause');
  });

  it('без прогона пауза невозможна', () => {
    expect(composerAction(key({ key: ' ', ctrlKey: true, shiftKey: true }), idle)).toBe('none');
  });
});

describe('composerHint', () => {
  it('на паузе говорит, как продолжить, а не только «пауза»', () => {
    expect(composerHint('pause', running)).toContain('Ctrl+Shift+Space');
  });

  it('стоп на паузе говорит, что было паузой', () => {
    expect(composerHint('stop', paused)).toBe('Остановлено на паузе');
  });

  it('стоп без паузы — просто «остановлено»', () => {
    expect(composerHint('stop', running)).toBe('Остановлено');
  });

  it('ничего не случилось — нечего и говорить', () => {
    expect(composerHint('none', running)).toBeNull();
  });
});

describe('focusAfterCard', () => {
  /**
   * Карточка в ленте заменяет себе содержимое (`replaceChildren`), и кнопка,
   * на которой стоял фокус, исчезает вместе с ним: фокус улетал
   * в `document.body`, и следующий Tab начинал обход страницы с начала.
   * Возвращать всегда в поле ввода тоже неверно — решение зависит от того,
   * кончился ли прогон.
   */
  it('прогон идёт — фокус в ленту: следующий вопрос придёт туда', () => {
    expect(focusAfterCard(true)).toBe('thread');
  });

  it('прогон кончился — фокус в поле ввода: самое время писать дальше', () => {
    expect(focusAfterCard(false)).toBe('composer');
  });
});
