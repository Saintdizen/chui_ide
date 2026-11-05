import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitDiffHunk } from '../src/shared/api';
import { createChangesPanel, type ChangesSource } from '../src/renderer/ui/chat-changes';
import { installMiniDom } from './helpers/mini-dom';

/**
 * Блоки правок в панели изменений чата (`renderer/ui/chat-changes.ts`).
 *
 * Человек правит не файл целиком, а одну правку: клик по файлу разворачивает его
 * до блоков против HEAD, блок можно проиндексировать. Без `deps.hunks` клик ведёт
 * себя по-старому — открывает файл в редакторе.
 */

beforeEach(() => {
  installMiniDom();
});

const hunks = (...ranges: Array<[number, number, number, number]>): GitDiffHunk[] =>
  ranges.map(([oldStart, oldCount, newStart, newCount]) => ({ oldStart, oldCount, newStart, newCount }));

const touched = (added = 3, removed = 1): ChangesSource => ({
  touched: new Map([['src/a.ts', { added, removed, original: '' }]]),
  files: [],
});

/** Дать развороту дорисоваться: он асинхронный. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Список живёт в попапе: панель сама его не содержит, но строкам это не мешает.
 * Ищем по документу — так тест повторяет то, что видит человек.
 *
 * Кликаем по `.changes-row-main`, а не по строке: строка — обёртка с кнопкой
 * «Копировать путь» рядом, и клик по самой обёртке не раскрывает файл (нельзя
 * класть `<button>` в `<button>` — браузер разворачивает).
 */
const rowsIn = (panel: ReturnType<typeof createChangesPanel>): HTMLElement[] => {
  const found = [...document.querySelectorAll('.changes-row-main')];
  if (found.length > 0) return found as HTMLElement[];
  // Мини-DOM начинает поиск с `body`: панель могла быть вставлена корнем.
  document.body.appendChild(panel.element);
  return [...document.querySelectorAll('.changes-row-main')] as HTMLElement[];
};

describe('createChangesPanel — блоки изменений', () => {
  it('без deps.hunks клик открывает файл, а не разворачивает', () => {
    const reveal = vi.fn();
    const panel = createChangesPanel({ reveal, onRevert() {}, onSave() {} });
    panel.render(touched());

    rowsIn(panel)[0]!.click();
    expect(reveal).toHaveBeenCalledWith('src/a.ts', 1, 1);
    expect(document.querySelectorAll('.changes-hunk').length).toBe(0);
  });

  it('клик по файлу запрашивает блоки и показывает их', async () => {
    const list = vi.fn(async () => hunks([1, 2, 1, 3], [10, 0, 12, 1]));
    const panel = createChangesPanel({ reveal() {}, onRevert() {}, onSave() {}, hunks: list });
    panel.render(touched());

    rowsIn(panel)[0]!.click();
    await settle();

    expect(list).toHaveBeenCalledWith('src/a.ts');
    expect(document.querySelectorAll('.changes-hunk').length).toBe(2);
  });

  it('«Проиндексировать» отдаёт номер блока из развёрнутого списка', async () => {
    const stage = vi.fn();
    const panel = createChangesPanel({
      reveal() {},
      onRevert() {},
      onSave() {},
      hunks: async () => hunks([1, 2, 1, 3], [10, 0, 12, 1]),
      onStageHunk: stage,
    });
    panel.render(touched());

    rowsIn(panel)[0]!.click();
    await settle();

    // Мини-DOM не разбирает составные селекторы (`.a .b`) — ищем по классу кнопки.
    const buttons = document.querySelectorAll('.changes-hunk-btn');
    // На каждый блок две кнопки: «Проиндексировать» и «Показать»; последний блок
    // вдобавок несёт «Откатить файл».
    const stageSecond = buttons[2] as HTMLElement;
    expect(buttons.length).toBe(5);
    stageSecond.click();

    // Второй блок приходит со своим GitDiffHunk, а не с индексом: номер считает
    // вызывающий — границы у него уже есть.
    expect(stage).toHaveBeenCalledTimes(1);
    expect(stage.mock.calls[0]![0]).toBe('src/a.ts');
    expect(stage.mock.calls[0]![1]).toEqual({ oldStart: 10, oldCount: 0, newStart: 12, newCount: 1 });
  });

  it('«Сравнить» открывает файл в экране различий', async () => {
    const openDiff = vi.fn();
    const panel = createChangesPanel({
      reveal() {},
      onRevert() {},
      onSave() {},
      hunks: async () => hunks([1, 2, 1, 3], [10, 0, 12, 1]),
      openDiff,
    });
    panel.render(touched());

    rowsIn(panel)[0]!.click();
    await settle();

    // Кнопка одна на блок и стоит после «Показать» — берём по подписи.
    const compare = [...(document.querySelectorAll('.changes-hunk-btn') as unknown as HTMLElement[])].find(
      (node) => node.textContent === 'Сравнить',
    );
    expect(compare).toBeDefined();
    compare!.click();
    expect(openDiff).toHaveBeenCalledWith('src/a.ts');
  });

  it('повторный клик по файлу сворачивает блоки', async () => {
    const panel = createChangesPanel({
      reveal() {},
      onRevert() {},
      onSave() {},
      hunks: async () => hunks([1, 2, 1, 3]),
    });
    panel.render(touched());

    rowsIn(panel)[0]!.click();
    await settle();
    expect(document.querySelectorAll('.changes-hunk').length).toBe(1);

    rowsIn(panel)[0]!.click();
    await settle();
    expect(document.querySelectorAll('.changes-hunk').length).toBe(0);
  });

  it('ошибка получения блоков видна текстом, а не как «блоков нет»', async () => {
    const panel = createChangesPanel({
      reveal() {},
      onRevert() {},
      onSave() {},
      hunks: async () => {
        throw new Error('нет git');
      },
    });
    panel.render(touched());

    rowsIn(panel)[0]!.click();
    await settle();

    expect(document.querySelector('.changes-hunk')).toBeNull();

    // Текст ошибки живёт в попапе, а не в шапке панели: шапка — только счётчики.
    expect(document.body.textContent).toContain('Не удалось');
  });
});

/**
 * Переход из ленты: «изменено файлов: 3» в шапке группы действий.
 *
 * Счётчик был только надписью — человек читал, что правки были, и шёл искать их
 * руками. Здесь проверяем, что панель умеет открыться снаружи и раскрыть файл.
 */
describe('createChangesPanel — переход из ленты', () => {
  const two: ChangesSource = {
    touched: new Map([
      ['src/a.ts', { added: 3, removed: 1, original: '' }],
      ['src/b.ts', { added: 1, removed: 0, original: '' }],
    ]),
    files: [],
  };

  it('без пути открывает список', () => {
    const panel = createChangesPanel({ reveal() {}, onRevert() {}, onSave() {} });
    panel.render(two);

    panel.open();

    expect(document.querySelectorAll('.changes-row').length).toBe(2);
  });

  it('с известным путём разворачивает именно его, а не соседний', async () => {
    const list = vi.fn(async () => hunks([5, 1, 5, 2]));
    const panel = createChangesPanel({ reveal() {}, onRevert() {}, onSave() {}, hunks: list });
    panel.render(two);

    panel.open('src/b.ts');
    await settle();

    expect(list).toHaveBeenCalledWith('src/b.ts');
    expect(document.querySelectorAll('.changes-hunk').length).toBe(1);
  });

  it('устаревший путь из старого сообщения открывает список, а не пустоту', async () => {
    const list = vi.fn(async () => hunks([1, 1, 1, 1]));
    const panel = createChangesPanel({ reveal() {}, onRevert() {}, onSave() {}, hunks: list });
    panel.render(two);

    // Файл откатили после ответа — в беседе его больше нет.
    panel.open('src/удалён.ts');
    await settle();

    expect(list).not.toHaveBeenCalled();
    // Список на месте: человек всё равно должен попасть в правки.
    expect(document.querySelectorAll('.changes-row').length).toBe(2);
  });

  it('повторный переход к тому же файлу не схлопывает уже раскрытый', async () => {
    const list = vi.fn(async () => hunks([1, 1, 1, 1]));
    const panel = createChangesPanel({ reveal() {}, onRevert() {}, onSave() {}, hunks: list });
    panel.render(two);

    panel.open('src/a.ts');
    await settle();
    panel.open('src/a.ts');
    await settle();

    // Из ленты пришли посмотреть, а не переключить: второй щелчок не прячет.
    expect(document.querySelectorAll('.changes-hunk').length).toBe(1);
  });

  it('нечего показывать — панель спрятана, открывать некуда', () => {
    const list = vi.fn(async () => hunks([1, 1, 1, 1]));
    const panel = createChangesPanel({ reveal() {}, onRevert() {}, onSave() {}, hunks: list });
    panel.render({ touched: new Map(), files: [] });

    panel.open('src/a.ts');

    expect(list).not.toHaveBeenCalled();
  });
});
