import { describe, expect, it } from 'vitest';
import {
  AutoPanelLayout,
  autoPanels,
  applyPanelIntent,
  panelBand,
  type PanelState,
} from '../src/renderer/core/panel-layout';

describe('panelBand', () => {
  it('делит ширину на узкую, обычную и широкую полосы по порогам', () => {
    expect(panelBand(600)).toBe('compact');
    expect(panelBand(999)).toBe('compact');
    expect(panelBand(1000)).toBe('regular');
    expect(panelBand(1199)).toBe('regular');
    expect(panelBand(1200)).toBe('wide');
    expect(panelBand(2560)).toBe('wide');
  });
});

describe('autoPanels', () => {
  it('на узком прячет обе панели, на широком показывает', () => {
    expect(autoPanels('compact')).toEqual({ sidebar: false, right: false });
    expect(autoPanels('regular')).toEqual({ sidebar: true, right: false });
    expect(autoPanels('wide')).toEqual({ sidebar: true, right: true });
  });
});

describe('applyPanelIntent', () => {
  const shown: PanelState = { sidebar: true, right: true, editor: true };

  it('обычное намерение исполняется как есть', () => {
    expect(applyPanelIntent(shown, { right: false })).toEqual({ sidebar: true, right: false, editor: true });
    expect(applyPanelIntent(shown, { editor: false })).toEqual({ sidebar: true, right: true, editor: false });
  });

  it('боковую можно свернуть всегда — она оглавление, а не содержимое', () => {
    expect(applyPanelIntent(shown, { sidebar: false })).toEqual({ sidebar: false, right: true, editor: true });
    expect(applyPanelIntent({ sidebar: true, right: true, editor: false }, { sidebar: false })).toEqual({
      sidebar: false,
      right: true,
      editor: false,
    });
  });

  it('при скрытом редакторе правую не свернуть', () => {
    // Иначе окно остаётся без единого содержимого.
    const hiddenEditor: PanelState = { sidebar: true, right: true, editor: false };
    expect(applyPanelIntent(hiddenEditor, { right: false })).toEqual(hiddenEditor);
  });

  it('скрытие редактора при свёрнутой правой возвращает правую', () => {
    const hiddenRight: PanelState = { sidebar: true, right: false, editor: true };
    expect(applyPanelIntent(hiddenRight, { editor: false })).toEqual({
      sidebar: true,
      right: true,
      editor: false,
    });
  });

  it('после любого намерения окно не остаётся пустым', () => {
    for (const sidebar of [true, false]) {
      for (const right of [true, false]) {
        for (const editor of [true, false]) {
          for (const intent of [{ sidebar: false }, { right: false }, { editor: false }, {}]) {
            const next = applyPanelIntent({ sidebar, right, editor }, intent);
            expect(next.right || next.editor, JSON.stringify({ sidebar, right, editor, intent })).toBe(true);
          }
        }
      }
    }
  });
});

describe('AutoPanelLayout', () => {
  it('на первом измерении сразу сворачивает лишние панели', () => {
    const layout = new AutoPanelLayout();
    expect(layout.update(800, { sidebar: true, right: true })).toEqual({ sidebar: false, right: false });
  });

  it('внутри полосы молчит: открытую вручную панель не схлопывает', () => {
    const layout = new AutoPanelLayout();
    layout.update(1200, { sidebar: true, right: true });
    // Ширина поменялась, но полоса та же — решения нет.
    expect(layout.update(1180, { sidebar: false, right: false })).toBeNull();
  });

  it('расширение возвращает только то, что свернул автопоказ', () => {
    const layout = new AutoPanelLayout();
    layout.update(800, { sidebar: true, right: true });
    // Уже обычная полоса: боковая возвращается, правая остаётся скрытой.
    expect(layout.update(1100, { sidebar: false, right: false })).toEqual({ sidebar: true, right: false });
    // Широкая полоса: возвращается и правая.
    expect(layout.update(1300, { sidebar: true, right: false })).toEqual({ sidebar: true, right: true });
  });

  it('панель, закрытую человеком, обратно не открывает', () => {
    const layout = new AutoPanelLayout();
    layout.update(1300, { sidebar: true, right: true });
    // На сужении человек сам держит правую закрытой — это его выбор, не наш.
    layout.update(900, { sidebar: true, right: false });
    // Возврат на широкую: боковая (наша) встаёт, правая (его) остаётся закрытой.
    expect(layout.update(1300, { sidebar: false, right: false })).toEqual({ sidebar: true, right: false });
  });

  it('когда раскладка уже совпала с полосой — не трогает ничего', () => {
    const layout = new AutoPanelLayout();
    layout.update(1300, { sidebar: true, right: true });
    expect(layout.update(900, { sidebar: false, right: false })).toBeNull();
  });
});
