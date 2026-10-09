import { describe, expect, it } from 'vitest';
import { placePopup } from '../src/renderer/core/popup-placement';

/** Статусбар внизу окна 800×600: якорь — кнопка окружения. */
const anchor = { top: 576, left: 160, right: 500, bottom: 596 };
const viewport = { width: 800, height: 600 };

describe('placePopup', () => {
  it('обычный случай: попап над якорем, прижат к его правому краю', () => {
    const placement = placePopup({ anchor, size: { width: 340, height: 300 }, viewport, gap: 6 });
    expect(placement.top).toBe(576 - 300 - 6);
    expect(placement.left).toBe(500 - 340);
  });

  it('попап выше якоря не влезает — кладём под ним', () => {
    const placement = placePopup({ anchor: { top: 40, left: 100, right: 300, bottom: 60 }, size: { width: 200, height: 100 }, viewport, gap: 6 });
    expect(placement.top).toBe(66);
  });

  it('высокий попап не уезжает за нижний край окна', () => {
    // Якорь у самого верха, а попап выше окна: прижимаем к верхнему краю.
    const placement = placePopup({ anchor, size: { width: 340, height: 590 }, viewport, gap: 6 });
    expect(placement.top).toBe(8);
    expect(placement.top + 590).toBeLessThanOrEqual(viewport.height - 0);
  });

  it('попап не уезжает и за верхний край', () => {
    const placement = placePopup({ anchor, size: { width: 340, height: 1000 }, viewport, gap: 6 });
    expect(placement.top).toBe(8);
  });

  it('длинный попап шире места справа — прижимаем к левому краю окна', () => {
    const placement = placePopup({
      anchor: { top: 300, left: 40, right: 100, bottom: 320 },
      size: { width: 900, height: 100 },
      viewport,
      gap: 6,
    });
    expect(placement.left).toBe(8);
  });

  it('прижатие start: попап растёт вправо от левого края якоря', () => {
    // Так открывается список изменений из композера: попап должен остаться
    // внутри панели чата, а не уехать за левый край окна.
    const placement = placePopup({ anchor, size: { width: 340, height: 200 }, viewport, gap: 6, align: 'start' });
    expect(placement.left).toBe(anchor.left);
  });

  it('прижатие start не даёт уехать и за правый край окна', () => {
    const placement = placePopup({
      anchor: { top: 300, left: 700, right: 760, bottom: 320 },
      size: { width: 340, height: 100 },
      viewport,
      gap: 6,
      align: 'start',
    });
    expect(placement.left).toBe(800 - 340 - 8);
  });

  it('зазор и отступ от края настраиваются', () => {
    const placement = placePopup({ anchor, size: { width: 340, height: 300 }, viewport, gap: 12, margin: 20 });
    expect(placement.top).toBe(576 - 300 - 12);
  });
});
