import type { RunTarget } from '../core/run-config';
import { h, svgIcon } from './dom';
import { showPopupMenu } from './popup-menu';

/**
 * Кнопка запуска в полосе хлебных крошек.
 *
 * Кнопка показывает, что именно запустится, и не появляется вовсе, если
 * запускать нечего: пустая кнопка «Запустить» хуже её отсутствия. Рядом —
 * стрелка со списком: в проекте Node запуск почти всегда идёт задачей из
 * package.json, а не файлом.
 */
export interface RunButtonView {
  element: HTMLElement;
  update(targets: readonly RunTarget[]): void;
}

export function createRunButton(run: (target: RunTarget) => void): RunButtonView {
  let targets: readonly RunTarget[] = [];

  const label = h('span', { class: 'run-button-label' }, 'Запустить');

  const main = h(
    'button',
    {
      class: 'run-button',
      type: 'button',
      title: 'Запустить',
      onClick: () => {
        const target = targets[0];
        if (target) run(target);
      },
    },
    svgIcon('play', 13),
    label,
  );

  const picker = h(
    'button',
    {
      class: 'run-picker',
      type: 'button',
      title: 'Выбрать, что запустить',
      onClick: () => openMenu(),
    },
    svgIcon('chevronDown', 12),
  );

  const element = h('div', { class: 'run-control', hidden: true }, main, picker);

  function openMenu(): void {
    if (targets.length === 0) return;
    const rect = picker.getBoundingClientRect();
    showPopupMenu(
      targets.map((target) => ({
        label: target.label,
        hint: target.detail,
        onSelect: () => run(target),
      })),
      rect.right - 240,
      rect.bottom + 2,
      { anchor: picker },
    );
  }

  return {
    element,
    update(next) {
      targets = next;
      const primary = next[0];
      element.hidden = !primary;
      if (!primary) return;

      // В подписи — цель, в подсказке — чем именно запускаем: интерпретатор
      // окружения и системный python выглядят одинаково, пока не увидишь путь.
      label.textContent = primary.label;
      main.title = [...new Set([primary.label, primary.detail, primary.command])].join('\n');
      picker.hidden = next.length < 2;
    },
  };
}
