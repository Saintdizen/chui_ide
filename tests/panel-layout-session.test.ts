import { describe, expect, it } from 'vitest';
import { AutoPanelLayout, COMPACT_WIDTH, MIN_TRUSTED_WIDTH } from '../src/renderer/core/panel-layout';

/**
 * Автопоказ панелей и выбор человека из прошлой сессии.
 *
 * TASKS просил «поведение при схлопывании окна до минимума» и «сохранение в
 * сессии». Проверено: обе половины продуманы в коде, но не были закреплены
 * тестом — а именно здесь легче всего сломать чужой выбор молча.
 */
describe('первый расчёт не переигрывает прошлую сессию', () => {
  it('узкое окно при восстановлении НЕ сворачивает панели', () => {
    // Главное: человек в прошлой сессии оставил панели открытыми, окно при
    // запуске узкое — автопоказ не вправе решить, что человек этого не хотел.
    // `restore` запоминает ПОЛОСУ и ничего не решает: решения не возвращается.
    const model = new AutoPanelLayout();
    model.restore(600, { sidebar: true, right: true });
    // И следующий расчёт по той же ширине уже ничего не меняет: полоса та же.
    expect(model.update(600, { sidebar: true, right: true })).toBeNull();
    // Сужение внутри ТОЙ ЖЕ полосы (600 → 819, обе «компактные») ничего не
    // решает: полоса не сменилась, а значит и мнения о ширине не появилось.
    expect(model.update(COMPACT_WIDTH - 1, { sidebar: true, right: true })).toBeNull();
    // А вот переход в ДРУГУЮ полосу — уже повод решить по-настоящему. Но
    // оба варианта открыты, значит показывать нечего: `null` — и это верно.
    // Решение появляется, когда полоса ЧЕГО-ТО не требует (см. ниже).
    expect(model.update(1600, { sidebar: true, right: true })).toBeNull();
  });

  it('свёрнутое окно (ширина 0) не считается мнением о ширине', () => {
    // Полоса по нулевой ширине — ложь, и решение по ней закрыло бы панели
    // без причины. Порог — MIN_TRUSTED_WIDTH.
    const model = new AutoPanelLayout();
    model.restore(1200, { sidebar: true, right: true });
    expect(model.update(0, { sidebar: true, right: true })).toBeNull();
    expect(model.update(MIN_TRUSTED_WIDTH - 1, { sidebar: true, right: true })).toBeNull();
  });

  it('порог компактного режима — граница, а не «около»', () => {
    // Первый расчёт от широкого окна: он и решает. Ровно на границе — ещё
    // обычный режим (панели остаются), шаг ниже — компактный (правая уходит).
    // 1200 — «регулярная» полоса: боковая нужна, правая уходит. Ровно на
    // границе 820 режим ещё НЕ компактный — боковая остаётся.
    const atBoundary = new AutoPanelLayout();
    atBoundary.restore(1200, { sidebar: true, right: true });
    expect(atBoundary.update(COMPACT_WIDTH, { sidebar: true, right: true })).toEqual({
      sidebar: true,
      right: false,
    });

    const below = new AutoPanelLayout();
    below.restore(1200, { sidebar: true, right: true });
    const change = below.update(COMPACT_WIDTH - 1, { sidebar: true, right: true });
    expect(change?.right).toBe(false);
  });

  it('вернули ширину — панель возвращается, а не остаётся спрятанной', () => {
    // Беда, которую легко не заметить: сузил окно, вернул — а панели нет,
    // и человек ищет её в меню.
    const model = new AutoPanelLayout();
    model.restore(1200, { sidebar: true, right: true });
    model.update(COMPACT_WIDTH - 1, { sidebar: true, right: true });
    const back = model.update(1400, { sidebar: false, right: false });
    expect(back).not.toBeNull();
    expect(back?.sidebar).toBe(true);
    expect(back?.right).toBe(true);
  });

  it('в «обычной» полосе правая панель уходит, в «широкой» снова нужна', () => {
    // Вот где решение появляется. Полосы: <820 компактная (обе уходят),
    // <1200 обычная (боковая нужна, правая нет), дальше широкая (обе нужны).
    const model = new AutoPanelLayout();
    model.restore(600, { sidebar: true, right: true });
    expect(model.update(1000, { sidebar: true, right: true })).toEqual({ sidebar: true, right: false });
    // Расширили до широкой — правая возвращается сама (её свернули НЕ мы).
    expect(model.update(1600, { sidebar: true, right: false })).toEqual({ sidebar: true, right: true });
  });

  it('человек закрыл панель сам — автопоказ её не откроет при возврате ширины', () => {
    // Самое важное: «было открыто, я сузил» и «я сам закрыл» — разные вещи.
    // Второе автопоказ обязан уважать, иначе панель всплывает против воли.
    const model = new AutoPanelLayout();
    model.restore(1400, { sidebar: false, right: false });
    const change = model.update(COMPACT_WIDTH - 1, { sidebar: false, right: false });
    expect(change).toBeNull();
    expect(model.update(1400, { sidebar: false, right: false })).toBeNull();
  });
});
