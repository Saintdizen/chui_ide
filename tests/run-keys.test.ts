import { describe, expect, it } from 'vitest';

import {
  composerAction,
  composerHint,
  feedAction,
  focusAfterCard,
  recallStep,
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

describe('feedAction: клавиатура ленты', () => {
  /*
    Лента — список сообщений, и от неё ждут поведения списка. До этого у ленты
    не было своей клавиатуры: PageUp/Home листали страницу целиком, а Escape
    никуда не вёл.
  */
  it('PageUp/PageDown — страница', () => {
    expect(feedAction(key({ key: 'PageUp' }))).toBe('page-up');
    expect(feedAction(key({ key: 'PageDown' }))).toBe('page-down');
  });

  it('Home/End — к краю беседы', () => {
    expect(feedAction(key({ key: 'Home' }))).toBe('to-start');
    expect(feedAction(key({ key: 'End' }))).toBe('to-end');
  });

  it('Escape уводит обратно в поле ввода', () => {
    expect(feedAction(key({ key: 'Escape' }))).toBe('composer');
  });

  it('с модификаторами не лезем: там выделение и системные жесты', () => {
    for (const mod of ['shiftKey', 'ctrlKey', 'metaKey', 'altKey'] as const) {
      expect(feedAction(key({ key: 'PageUp', [mod]: true }))).toBe('none');
      expect(feedAction(key({ key: 'Escape', [mod]: true }))).toBe('none');
    }
  });

  it('буквы в ленте остаются браузеру', () => {
    expect(feedAction(key({ key: 'a' }))).toBe('none');
    // Стрелки в ленте заняты прыжками по вопросам (Alt+↑/↓ — отдельный слой).
    expect(feedAction(key({ key: 'ArrowUp' }))).toBe('none');
  });
});

describe('recallStep: ↑ по прошлым вопросам', () => {
  it('первый ↑ от черновика — самый свежий вопрос', () => {
    expect(recallStep(null, -1, 3)).toBe(2);
  });

  it('дальше ↑ — назад по времени', () => {
    expect(recallStep(2, -1, 3)).toBe(1);
    expect(recallStep(1, -1, 3)).toBe(0);
  });

  it('на самом старом упирается, а не проваливается', () => {
    expect(recallStep(0, -1, 3)).toBe(0);
  });

  it('↓ идёт вперёд и за последним вопросом возвращает черновик', () => {
    expect(recallStep(0, 1, 3)).toBe(1);
    expect(recallStep(2, 1, 3)).toBeNull();
  });

  it('в черновике ↓ ничего не делает', () => {
    expect(recallStep(null, 1, 3)).toBeNull();
  });

  it('в пустой беседе вспоминать нечего', () => {
    expect(recallStep(null, -1, 0)).toBeNull();
    expect(recallStep(0, 1, 0)).toBeNull();
  });

  it('вопрос всего один: ↑ возвращает его, ↓ возвращает черновик', () => {
    expect(recallStep(null, -1, 1)).toBe(0);
    expect(recallStep(0, 1, 1)).toBeNull();
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
