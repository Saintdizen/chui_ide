import { beforeEach, describe, expect, it } from 'vitest';
import { createLayout } from '../src/renderer/ui/layout';
import { installMiniDom } from './helpers/mini-dom';

/**
 * Плавающая панель в раскладке (`ui/layout.ts`).
 *
 * Проверяется главное обещание режима: панель НЕ пересобирается при переезде.
 * Внутри неё живут терминал и поиск; если бы переезд пересоздавал узел, они
 * возвращались бы пустыми — плавающая панель была бы бесполезной.
 *
 * Геометрия тут не проверяется: она в `shared/floating-dock.ts` и своих тестах.
 * Здесь — только кто чей родитель.
 */

beforeEach(() => {
  installMiniDom();
});

function setup() {
  const mount = document.createElement('div') as unknown as HTMLElement;
  const layout = createLayout(mount);
  // Что-то живое внутри панели: подпись, которую легко узнать после переезда.
  const payload = document.createElement('div') as unknown as HTMLElement;
  payload.textContent = 'терминал';
  layout.dockHost.appendChild(payload);
  const layer = layout.root.querySelector('.floating-layer') as unknown as HTMLElement;
  return { mount, layout, payload, layer };
}

describe('плавающая панель', () => {
  it('по умолчанию стоит в сетке', () => {
    const { layout, payload } = setup();
    expect(layout.dockFloating).toBe(false);
    expect(payload.closest('.dock-wrap')).not.toBeNull();
  });

  it('переезжает в слой поверх, а не пересобирается', () => {
    const { layout, payload } = setup();
    const before = payload.parentElement;
    layout.setDockFloating(true);
    expect(layout.dockFloating).toBe(true);
    // Тот же самый узел — и он же со своим содержимым.
    expect(payload.parentElement).toBe(before);
    expect(payload.textContent).toBe('терминал');
  });

  it('возвращается в сетку на своё место', () => {
    const { layout, payload } = setup();
    layout.setDockFloating(true);
    layout.setDockFloating(false);
    expect(layout.dockFloating).toBe(false);
    expect(payload.closest('.dock-wrap')).not.toBeNull();
    expect(payload.textContent).toBe('терминал');
  });

  it('переезд туда-обратно не теряет содержимое', () => {
    const { layout, payload } = setup();
    for (let i = 0; i < 3; i += 1) {
      layout.setDockFloating(true);
      layout.setDockFloating(false);
    }
    expect(payload.textContent).toBe('терминал');
    expect(layout.dockHost.contains(payload)).toBe(true);
  });

  it('в плавающем виде размер задаётся в пикселях, в сетке — снимается', () => {
    const { layout } = setup();
    layout.setDockFloating(true);
    const island = layout.dockHost.closest('.dock') as unknown as HTMLElement;
    expect(island.style.position).toBe('absolute');
    layout.setDockFloating(false);
    // Снято, а не 'auto' или прошлое значение: размер должен вернуться к
    // сеточному. Пустая строка или ничего — в зависимости от DOM; важно, что
    // пиксельный размер не остался.
    expect(island.style.position || '').toBe('');
    expect(island.style.width || '').toBe('');
  });

  it('сдвиг панели в сетке ничего не делает', () => {
    const { layout } = setup();
    // Не должно ни упасть, ни завести плавающее состояние из ниоткуда.
    layout.moveDockFloating(50, 50);
    expect(layout.dockFloating).toBe(false);
  });
});
