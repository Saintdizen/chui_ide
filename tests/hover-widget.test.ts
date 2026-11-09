import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HOVER_COLLAPSED_LINES,
  HOVER_DELAY_MS,
  HOVER_MAX_HEIGHT_RATIO,
  HoverWidget,
} from '../src/renderer/editor/widgets/hover-widget';
import { TextBuffer } from '../src/renderer/editor/core/text-buffer';
import { installMiniDom } from './helpers/mini-dom';

/**
 * Карточка при наведении: пауза, раскрытие и предел высоты (TASKS 72).
 *
 * Стены настоящего редактора не нужны: виджету от вида требуются только `element`
 * (куда встать) и `tokenTypeAt` (что за слово). Всё остальное — заглушки.
 */

const TEXT = 'const value = 1;\nvalue += value;\n';

function setup(delayMs?: number) {
  const dom = installMiniDom();
  const element: any = dom.document.createElement('div');
  const viewport: any = dom.document.createElement('div');
  viewport.className = 'own-editor-viewport';
  element.append(viewport);
  dom.document.body.append(element);
  const view = { element, tokenTypeAt: () => 0, offsetAt: (x: number) => x } as any;
  const widget = new HoverWidget(view, new TextBuffer(TEXT), {
    ...(delayMs !== undefined ? { delayMs } : {}),
  });
  /** Наведение мыши: виджет ждёт паузу, потом берёт слово по `offsetAt` (здесь — само X). */
  const hover = (offset: number) => {
    viewport.dispatchEvent({ type: 'mousemove', clientX: offset, clientY: 200 });
  };
  return { widget, dom, hover };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('наведение: пауза', () => {
  it('по умолчанию — константа из настроек по умолчанию', () => {
    expect(HOVER_DELAY_MS).toBe(350);
  });

  it('до паузы карточки нет, после — есть', () => {
    const { widget, hover } = setup();
    // `value` встречается дважды — о слове есть что сказать.
    hover(TEXT.indexOf('value'));
    expect(widget.isVisible).toBe(false);
    vi.advanceTimersByTime(HOVER_DELAY_MS - 1);
    expect(widget.isVisible).toBe(false);
    vi.advanceTimersByTime(1);
    expect(widget.isVisible).toBe(true);
  });

  it('настройка меняет паузу, не перезапуская редактор', () => {
    const { widget, hover } = setup();
    widget.setDelay(1000);
    hover(TEXT.indexOf('value'));
    vi.advanceTimersByTime(HOVER_DELAY_MS);
    // Старой паузы мало: человек выбрал ждать дольше.
    expect(widget.isVisible).toBe(false);
    vi.advanceTimersByTime(1000 - HOVER_DELAY_MS);
    expect(widget.isVisible).toBe(true);
  });

  it('ноль — показывать сразу', () => {
    const { widget, hover } = setup(0);
    hover(TEXT.indexOf('value'));
    expect(widget.isVisible).toBe(true);
  });

  it('мусор в настройке не ломает паузу', () => {
    const { widget, hover } = setup();
    widget.setDelay(Number.NaN);
    widget.setDelay(-5);
    hover(TEXT.indexOf('value'));
    vi.advanceTimersByTime(HOVER_DELAY_MS);
    expect(widget.isVisible).toBe(true);
  });

  it('мышь поехала до истечения паузы — ничего не всплывает', () => {
    const { widget, hover } = setup();
    hover(TEXT.indexOf('value'));
    vi.advanceTimersByTime(HOVER_DELAY_MS - 50);
    // Поехали дальше — прежняя пауза сбрасывается, начинается новая.
    hover(TEXT.indexOf('value', 10));
    vi.advanceTimersByTime(HOVER_DELAY_MS - 1);
    expect(widget.isVisible).toBe(false);
  });

  // П.34: «держи Ctrl — подсказка сразу». Ждать паузу, стоя замерев, — то, за что
  // подсказку и выключают: она есть, но увидеть её надо через секунду.
  it('Ctrl над словом — карточка сразу, без паузы', () => {
    const { widget, dom } = setup();
    const viewport = dom.document.querySelector('.own-editor-viewport');
    viewport.dispatchEvent({
      type: 'mousemove',
      clientX: TEXT.indexOf('value'),
      clientY: 200,
      ctrlKey: true,
    });
    expect(widget.isVisible).toBe(true);
  });

  it('без Ctrl до паузы карточки нет', () => {
    const { widget, hover } = setup();
    hover(TEXT.indexOf('value'));
    expect(widget.isVisible).toBe(false);
  });
});

describe('наведение: длинная карточка', () => {
  const longSource = (lines: number) => async () => ({
    text: Array.from({ length: lines }, (_, i) => `строка ${i + 1}`).join('\n'),
  });

  const shown = async (lines: number) => {
    const dom = installMiniDom();
    const element: any = dom.document.createElement('div');
    element.append(dom.document.createElement('div'));
    dom.document.body.append(element);
    const view = { element, tokenTypeAt: () => 0 } as any;
    const widget = new HoverWidget(view, new TextBuffer(TEXT), { delayMs: 0, sources: [longSource(lines)] });
    widget.showAt(TEXT.indexOf('value'), 100, 200);
    // Ждём ответ источника — он приходит микрошагом.
    await vi.runAllTimersAsync();
    return { widget, dom };
  };

  it('длинный ответ раскрыт не целиком: хвост — по Ctrl', async () => {
    const { widget, dom } = await shown(40);
    const root: any = dom.document.body.querySelector('.own-editor-hover');
    expect(widget.isVisible).toBe(true);
    expect(root.classList.contains('is-collapsed')).toBe(true);
  });

  it('короткий ответ не сворачивается', async () => {
    const { widget, dom } = await shown(2);
    const root: any = dom.document.body.querySelector('.own-editor-hover');
    expect(widget.isVisible).toBe(true);
    expect(root.classList.contains('is-collapsed')).toBe(false);
    expect(2).toBeLessThanOrEqual(HOVER_COLLAPSED_LINES);
  });

  it('Ctrl раскрывает целиком, отпустили — снова короткая', async () => {
    const { widget, dom } = await shown(40);
    const root: any = dom.document.body.querySelector('.own-editor-hover');
    dom.window.dispatchEvent({ type: 'keydown', key: 'Control', preventDefault() {} });
    expect(root.classList.contains('is-collapsed')).toBe(false);
    expect(widget.isVisible).toBe(true);
    // Отпустили — карточка возвращается к короткому виду: она не остаётся развёрнутой
    // от мимолётного нажатия.
    dom.window.dispatchEvent({ type: 'keyup', key: 'Control' });
    expect(root.classList.contains('is-collapsed')).toBe(true);
  });

  it('раскрытая карточка ограничена долей окна, а не тянется через экран', async () => {
    const { dom } = await shown(400);
    const root: any = dom.document.body.querySelector('.own-editor-hover');
    const limit = Math.round(dom.window.innerHeight * HOVER_MAX_HEIGHT_RATIO);
    expect(root.style.maxHeight).toBe(`${limit}px`);
    expect(HOVER_MAX_HEIGHT_RATIO).toBeLessThan(1);
  });
});
