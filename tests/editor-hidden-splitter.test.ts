import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readStyle } from './style-files';

/**
 * Скрытый редактор и шов между панелями.
 *
 * Редактора нет — левая и правая панели стоят вплотную. Два зазора подряд дали бы
 * широкую двойную полосу и две ручки на одном стыке, поэтому правило одно: зазор
 * остаётся у боковой панели (он же тянет её ширину), правый убирается целиком.
 *
 * Проверка по тексту CSS — единственное, что здесь можно проверить: раскладка живёт
 * в grid, а вычисленные колонки в тестах (окружение node) не считаются.
 */
const CHROME = readStyle('chrome.css');

/** Тело правила по точному селектору: от `{` до первой `}`. */
function rule(selector: string): string | null {
  // Ищем с начала строки: иначе `.dock-wrap {` нашёлся бы внутри более длинного
  // селектора `.app.is-editor-hidden:not(.is-dock-hidden) .dock-wrap {` и тест
  // читал бы не то правило.
  const start = CHROME.indexOf(`\n${selector} {`);
  if (start < 0) return null;
  const open = CHROME.indexOf('{', start);
  return CHROME.slice(open + 1, CHROME.indexOf('}', open));
}

describe('скрытый редактор', () => {
  it('не оставляет двойного зазора между панелями', () => {
    const block = rule('.app.is-editor-hidden');
    expect(block).not.toBeNull();
    expect(block).toContain('--editor-width: 0px');
    expect(block).toContain('--right-gap: 0px');
  });

  it('держит один сплиттер: правый убирается, левый остаётся', () => {
    expect(rule('.app.is-editor-hidden .splitter-right')).toMatch(/display:\s*none/);
    // Левый сплиттер живёт в колонке `--sidebar-gap` — она не обнуляется.
    expect(CHROME).not.toMatch(/\.app\.is-editor-hidden[^{]*\.splitter-left\b/);
    expect(rule('.app.is-editor-hidden')).not.toContain('--sidebar-gap: 0px');
  });

  it('освободившееся место отдаёт правой панели — но не уже её минимума', () => {
    const block = rule('.app.is-editor-hidden:not(.is-right-hidden)');
    expect(block).toContain('--right-width: minmax(250px, 1fr)');
    // 250 — `RIGHT_MIN_SIZE` из `ui/layout.ts`: нижняя граница живёт в одном месте.
    expect(readFileSync(resolve(process.cwd(), 'src/renderer/ui/layout.ts'), 'utf8')).toMatch(
      /const RIGHT_MIN_SIZE = 250;/,
    );
  });

  it('с открытым доком место редактора уходит доку, а не правой панели', () => {
    // У дока своя дорожка — колонка редактора: если она нулевая, остров сжимается
    // до ширины боковой панели и висит узкой полоской под деревом.
    const flexible = rule('.app.is-editor-hidden:not(.is-dock-hidden)');
    expect(flexible).toContain('--editor-width: minmax(0, 1fr)');

    // Правая возвращается к своей ширине и к своему шву: ручка между доком и чатом.
    const right = rule('.app.is-editor-hidden:not(.is-dock-hidden):not(.is-right-hidden)');
    expect(right).toContain('--right-gap: var(--space_sm)');
    expect(right).toContain('--right-width: var(--right-size)');
    expect(rule('.app.is-editor-hidden:not(.is-dock-hidden):not(.is-right-hidden) .splitter-right')).toMatch(
      /display:\s*block/,
    );
  });

  it('док и правый шов — только вместе: без дока они вернули бы двойную полосу', () => {
    // Гибкая колонка и `--right-size` объявлены только под `:not(.is-dock-hidden)`,
    // а оба прочих правила сидят под `is-dock-hidden` или под `is-right-hidden`.
    expect(rule('.app.is-editor-hidden')).toContain('--right-gap: 0px');
    expect(rule('.app.is-editor-hidden .splitter-right')).toMatch(/display:\s*none/);
  });

  it('док живёт только под редактором и не заходит под проводник', () => {
    expect(rule('.dock-wrap')).toContain('grid-column: 4');
    // Проводник и его ручка догоняют низ: иначе под ними осталась бы пустая полоса
    // высотой с док, а ручка обрывалась бы на его верхней кромке.
    expect(rule('.sidebar')).toContain('grid-row: 2 / 4');
    expect(rule('.splitter-left')).toContain('grid-row: 2 / 4');
  });

  it('с открытым доком над ним не остаётся пустой зоны', () => {
    // Место редактора есть (колонка гибкая), но рисовать в нём нечего — значит
    // остров дока поднимается на оба ряда и занимает всю рабочую высоту.
    const wrap = rule('.app.is-editor-hidden:not(.is-dock-hidden) .dock-wrap');
    expect(wrap).toContain('grid-row: 2 / 4');
    expect(wrap).toContain('grid-template-rows: minmax(0, 1fr)');
    //Верхняя ручка без работы: тянуть некуда — высота уже вся.
    expect(rule('.app.is-editor-hidden:not(.is-dock-hidden) .dock-wrap > .splitter-dock')).toMatch(/display:\s*none/);
  });

  it('центр скрыт всегда — иначе при открытом доке показался бы «скрытый» редактор', () => {
    expect(rule('.app.is-editor-hidden .center')).toMatch(/display:\s*none/);
  });
});
