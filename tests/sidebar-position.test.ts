import { describe, expect, it } from 'vitest';
import { readStyle } from './style-files';

/**
 * Переезд боковой панели на другую сторону.
 *
 * Переезд — не пересборка DOM, а порядок дорожек сетки: содержимое панели
 * (проводник, открытые редакторы, артефакты) остаётся в своём единственном
 * `aside` и переезжает вместе с ним. Проверка по тексту CSS — единственное,
 * что доступно в node: вычисленные колонки grid здесь не считаются.
 */
const CHROME = readStyle('chrome.css');

/**
 * Тела всех правил, где селектор встречается отдельным звеном.
 *
 * Селекторы в `chrome.css` часто сгруппированы через запятую
 * (`.sidebar, .splitter-left`), поэтому одного «селектор {» мало: берём любой блок,
 * в заголовке которого селектор стоит сам по себе.
 */
function rules(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[,{}])\\s*${escaped}\\s*[,{]`, 'gm');
  const bodies: string[] = [];
  for (const match of CHROME.matchAll(re)) {
    const open = CHROME.indexOf('{', match.index + match[0].length - 1);
    if (open < 0) continue;
    bodies.push(CHROME.slice(open + 1, CHROME.indexOf('}', open)));
  }
  return bodies;
}

/** Есть ли у правил с этим селектором хоть одно из объявлений. */
function declares(selector: string, pattern: RegExp): boolean {
  return rules(selector).some((body) => pattern.test(body));
}

/** Тело первого правила с селектором в заголовке (для проверок порядка). */
function rule(selector: string): string {
  return rules(selector)[0] ?? '';
}

describe('боковая панель справа', () => {
  it('меняет порядок дорожек, а не их размеры', () => {
    const block = rule('.app.is-sidebar-right');
    // Те же переменные, что и в раскладке по умолчанию: ширины задаются сплиттерами
    // и не должны зависеть от стороны.
    for (const name of ['--sidebar-width', '--sidebar-gap', '--right-width', '--right-gap']) {
      expect(block).toContain(name);
    }
    // Боковая панель ушла в конец ряда, редактор — вперёд.
    const order = block.slice(block.indexOf('grid-template-columns'));
    expect(order.indexOf('--right-width')).toBeLessThan(order.indexOf('--sidebar-width'));
  });

  it('ставит сами панели в новые колонки', () => {
    // 6px · редактор · зазор · правая · зазор · боковая · 6px
    expect(declares('.app.is-sidebar-right .sidebar', /grid-column:\s*6/)).toBe(true);
    expect(declares('.app.is-sidebar-right .right-panel', /grid-column:\s*4/)).toBe(true);
    expect(declares('.app.is-sidebar-right > .center', /grid-column:\s*2/)).toBe(true);
    // Ручки едут вместе с панелями: левая тянет боковую (теперь справа),
    // правая — панель ассистента (теперь левее её).
    expect(declares('.app.is-sidebar-right .splitter-left', /grid-column:\s*5/)).toBe(true);
    expect(declares('.app.is-sidebar-right .splitter-right', /grid-column:\s*3/)).toBe(true);
  });

  it('не конфликтует со сворачиванием: скрытая панель исчезает в любой колонке', () => {
    // `display: none` по классу `is-sidebar-hidden` сильнее колонки — поэтому
    // порядок проверок в CSS не важен, а `!important` не нужен.
    expect(declares('.app.is-sidebar-hidden .sidebar', /display:\s*none/)).toBe(true);
  });
});
