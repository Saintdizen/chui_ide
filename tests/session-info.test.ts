// biome-ignore-all lint/suspicious/noExplicitAny: узлы мини-DOM шире настоящих —
// тип нужен только внутри файла, чтобы обойти дерево в проверках.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionInfo, type SessionInfoData } from '../src/renderer/ui/session-info';
import { installMiniDom } from './helpers/mini-dom';

/**
 * Панель «Информация о сессии» (пункт 4 части 5 TASKS).
 *
 * Проверяются три вещи, которых не было: строка контекста раскрывается и
 * показывает СВОЙ текст, у «Файлов» есть снятие разом, а у частей без
 * выключателя честно написано, что убрать их нельзя.
 *
 * Грабли мини-DOM: поиск идёт по одному классу (селектор с пробелом не
 * разбирается), а клик — это `dispatchEvent` с объектом, у которого есть
 * `stopPropagation`, иначе обработчик падает.
 */

function data(over: Partial<SessionInfoData> = {}): SessionInfoData {
  return {
    messages: [{ role: 'user', content: 'привет' }],
    history: [],
    model: 'test-model',
    attachments: [],
    systemPrompt: 'Ты помощник редактора.',
    limit: 100_000,
    ...over,
  } as SessionInfoData;
}

function findAll(node: any, className: string): any[] {
  const found: any[] = [];
  const walk = (current: any) => {
    if ((current.className ?? '').split(/\s+/).includes(className)) found.push(current);
    for (const child of current.childNodes ?? []) walk(child);
  };
  walk(node);
  return found;
}

function click(node: any): void {
  node.dispatchEvent({ type: 'click', stopPropagation: () => {}, preventDefault: () => {} });
}

describe('session-info: части контекста', () => {
  beforeEach(() => installMiniDom());

  it('раскрывает собственную строку и показывает в ней текст части', () => {
    const view = createSessionInfo({ onCompact: () => {} });
    view.show(data());

    const rows = findAll(view.element, 'session-info-row');
    expect(rows.length).toBeGreaterThan(0);
    const system = rows.find((row) => row.textContent.includes('Системные инструкции'));
    expect(system).toBeTruthy();

    // До клика подробностей нет: строка — цифра, а не текст.
    expect(findAll(view.element, 'session-info-detail').length).toBe(0);
    click(system);

    const detail = findAll(view.element, 'session-info-detail');
    expect(detail.length).toBe(1);
    // Именно своя часть: в промпте лежит текст системных инструкций.
    expect(detail[0].textContent).toContain('Ты помощник редактора');
  });

  it('у части без выключателя прямо сказано, что убрать её нельзя', () => {
    const view = createSessionInfo({ onCompact: () => {} });
    view.show(data());

    const system = findAll(view.element, 'session-info-row').find((row) =>
      row.textContent.includes('Системные инструкции'),
    );
    click(system);

    expect(findAll(view.element, 'session-info-detail-locked').length).toBe(1);
    expect(findAll(view.element, 'session-info-detail-drop').length).toBe(0);
  });

  it('«Файлы» снимаются разом одной кнопкой', () => {
    const onDropFiles = vi.fn();
    const view = createSessionInfo({ onCompact: () => {}, onDropFiles });
    view.show(
      data({
        attachments: [
          { kind: 'file', label: 'a.ts', title: '/p/a.ts', text: 'const a = 1;' },
          { kind: 'file', label: 'b.ts', title: '/p/b.ts', text: 'const b = 2;' },
        ],
      } as Partial<SessionInfoData>),
    );

    const files = findAll(view.element, 'session-info-row').find((row) => row.textContent.includes('Файлы'));
    click(files);

    const drop = findAll(view.element, 'session-info-detail-drop');
    expect(drop.length).toBe(1);
    click(drop[0]);
    expect(onDropFiles).toHaveBeenCalledTimes(1);
  });

  it('раскрытая строка переживает перерисовку — и наоборот, хлопается по клику', () => {
    const view = createSessionInfo({ onCompact: () => {} });
    view.show(data());
    const system = () =>
      findAll(view.element, 'session-info-row').find((row) => row.textContent.includes('Системные инструкции'));

    click(system());
    expect(findAll(view.element, 'session-info-detail').length).toBe(1);

    // Перерисовка идёт на каждой правке: открытая строка не должна захлопываться.
    view.show(data());
    expect(findAll(view.element, 'session-info-detail').length).toBe(1);

    click(system());
    expect(findAll(view.element, 'session-info-detail').length).toBe(0);
  });
});
