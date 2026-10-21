import { describe, expect, it } from 'vitest';
import { createLspProgressController, lspProgressView } from '../src/renderer/core/lsp-progress';
import type { LspProgress } from '../src/shared/lsp-progress';

/**
 * Состояние полоски «сервер занят» — в отличие от `lsp-progress.test.ts` (там разбор
 * уведомления). Проверяем то, что легко сломать: параллельные занятия, повторный
 * `report` и забытый токен.
 */

const work = (
  token: string | number,
  phase: 'begin' | 'report' | 'end',
  title?: string,
  percentage?: number,
): LspProgress => ({
  kind: 'work',
  token,
  phase,
  title,
  percentage,
});

function setup() {
  const shown: Array<{ label: string; percentage: number | null } | null> = [];
  const controller = createLspProgressController({ show: (view) => shown.push(view) });
  return { controller, shown };
}

describe('createLspProgressController', () => {
  it('begin показывает занятие', () => {
    const { controller, shown } = setup();
    controller.apply(work(1, 'begin', 'Индексирую файлы', 0));
    expect(lspProgressView(controller)).toEqual({ label: 'Индексирую файлы', percentage: 0 });
    expect(shown.length).toBeGreaterThan(0);
  });

  it('report уточняет проценты', () => {
    const { controller } = setup();
    controller.apply(work(1, 'begin', 'Индексирую', 0));
    controller.apply(work(1, 'report', undefined, 40));
    expect(lspProgressView(controller)?.percentage).toBe(40);
  });

  it('два занятия параллельно: показываем последнее начатое', () => {
    const { controller } = setup();
    controller.apply(work('a', 'begin', 'Индексирую'));
    controller.apply(work('b', 'begin', 'Ищу ссылки'));
    expect(lspProgressView(controller)?.label).toBe('Ищу ссылки');
    expect(controller.count()).toBe(2);
  });

  it('конец одного не гасит полоску, пока идёт другой', () => {
    const { controller } = setup();
    controller.apply(work('a', 'begin', 'Индексирую'));
    controller.apply(work('b', 'begin', 'Ищу ссылки'));
    controller.apply(work('b', 'end'));
    expect(lspProgressView(controller)?.label).toBe('Индексирую');
    expect(controller.count()).toBe(1);
  });

  it('последний end убирает полоску', () => {
    const { controller, shown } = setup();
    controller.apply(work(1, 'begin', 'Индексирую'));
    controller.apply(work(1, 'end'));
    expect(lspProgressView(controller)).toBeNull();
    expect(shown.at(-1)).toBeNull();
  });

  it('повторный report с тем же текстом не трогает показ', () => {
    const { controller, shown } = setup();
    controller.apply(work(1, 'begin', 'Индексирую', 40));
    const before = shown.length;
    controller.apply(work(1, 'report', undefined, 40));
    expect(shown.length).toBe(before);
  });

  it('не-work не показываем: это ответ по кускам, его ждёт не человек', () => {
    const { controller, shown } = setup();
    controller.apply({ kind: 'partial', token: 1, value: 'кусок' } as unknown as LspProgress);
    expect(controller.count()).toBe(0);
    expect(shown).toEqual([]);
  });

  it('reset забывает всё: после перезапуска сервера старые отчёты не в счёт', () => {
    const { controller } = setup();
    controller.apply(work(1, 'begin', 'Индексирую'));
    controller.reset();
    expect(controller.count()).toBe(0);
    expect(lspProgressView(controller)).toBeNull();
  });

  it('end по неизвестному токену ничего не ломает', () => {
    const { controller } = setup();
    controller.apply(work('нет-такого', 'end'));
    expect(lspProgressView(controller)).toBeNull();
  });
});
