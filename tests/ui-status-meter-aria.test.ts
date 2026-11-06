import { describe, expect, it, vi } from 'vitest';
import { installMiniDom } from './helpers/mini-dom';

/**
 * Долгая работа в статус-баре: что читалка услышит, когда идёт сервер, обход проекта
 * или проверка.
 *
 * Проверяется не текст модуля, а живое поведение: статус-бар собирается настоящим
 * `createStatusBar` на мини-DOM, и `update()` дёргается как из окна. Тонкости, которые
 * легко сломать незаметно:
 *
 * - полоса — `progressbar`, и значения обновляются вместе с шириной;
 * - работа без процента не обещает числа: `aria-valuenow` у неё НЕТ, иначе читалка
 *   скажет «0 процентов» о том, что идёт;
 * - скрытая полоса молчит совсем: ни значения, ни подписи — иначе читалка будет
 *   объявлять работу, которой нет;
 * - подпись уходит вместе с полосой, а не остаётся пустой строкой: пустой
 *   `aria-valuetext` заглушил бы и число.
 */

type Module = typeof import('../src/renderer/ui/statusbar');

async function mount(): Promise<{ bar: import('../src/renderer/ui/statusbar').StatusBarView; meter: HTMLElement }> {
  installMiniDom();
  vi.resetModules();
  const { createStatusBar } = (await import('../src/renderer/ui/statusbar')) as Module;
  const noop = () => {};
  const bar = createStatusBar({
    openGitManager: noop,
    openPythonEnv: noop,
    openNodeEnv: noop,
    openProblems: noop,
    openLsp: noop,
    runCommand: noop,
    openChoice: noop,
    forceHighlight: noop,
    cancelWork: noop,
  });
  const meter = bar.element.querySelector('.status-meter') as unknown as HTMLElement;
  return { bar, meter };
}

describe('полоса долгой работы говорит читалке, сколько прошло', () => {
  it('объявлена как progressbar и живёт в полосе', async () => {
    const { meter } = await mount();
    expect(meter).toBeTruthy();
    expect(meter.getAttribute('role')).toBe('progressbar');
  });

  it('проценты попадают в атрибуты вместе с шириной', async () => {
    const { bar, meter } = await mount();
    bar.update({ progress: { label: 'Проверяю projeto', percentage: 42 } });

    expect(meter.hidden).toBe(false);
    expect(meter.getAttribute('aria-valuemin')).toBe('0');
    expect(meter.getAttribute('aria-valuemax')).toBe('100');
    expect(meter.getAttribute('aria-valuenow')).toBe('42');
    // Подпись — то, что читалка произносит вместо числа: словами лучше, чем «42».
    expect(meter.getAttribute('aria-valuetext')).toContain('Проверяю');
  });

  it('работа без процента не обещает числа', async () => {
    const { bar, meter } = await mount();
    bar.update({ progress: { label: 'Запускаю сервер', percentage: null } });

    // Полоса видна и «крутится», но числа нет: мы его не знаем.
    expect(meter.hidden).toBe(false);
    expect(meter.getAttribute('aria-valuenow')).toBeNull();
    expect(meter.getAttribute('aria-valuetext')).toContain('Запускаю сервер');
  });

  it('скрытая полоса молчит — и значения, и подписи нет', async () => {
    const { bar, meter } = await mount();
    bar.update({ progress: { label: 'Проверяю projeto', percentage: 42 } });
    expect(meter.getAttribute('aria-valuenow')).toBe('42');

    // Работа кончилась: полоса уходит, и объявлять больше нечего.
    bar.update({ progress: null });
    expect(meter.hidden).toBe(true);
    expect(meter.getAttribute('aria-valuenow')).toBeNull();
    expect(meter.getAttribute('aria-valuetext')).toBeNull();
  });

  it('обход проекта считает файлы — читалка слышит «3 из 10», а не «30 процентов»', async () => {
    const { bar, meter } = await mount();
    // В живом окне подпись строит `symbolIndexChip`: «читаю проект: 3 из 10».
    // Шкала при этом в процентах (`aria-valuenow`), но слышит человек иное:
    // файлы, не проценты. Поэтому подпись важна и должна нести числа.
    bar.update({ symbols: { text: 'читаю проект: 3 из 10', title: 'Карта символов', progress: { done: 3, total: 10 } } });

    expect(meter.getAttribute('aria-valuenow')).toBe('30');
    expect(meter.getAttribute('aria-valuetext')).toBe('читаю проект: 3 из 10');
  });

  it('число в `aria-valuenow` — доля, и она сходится с шириной полосы', async () => {
    const { bar, meter } = await mount();
    bar.update({ progress: { label: 'Сжимаю', percentage: 7 } });

    // 7% — это тоже процент, и округление не должно терять его в подписи.
    expect(meter.getAttribute('aria-valuenow')).toBe('7');
  });
});
