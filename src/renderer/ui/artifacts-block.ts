/**
 * Панель артефактов: что агент предъявил в этом разговоре.
 *
 * Карточка в ленте живёт один шаг, а после прогона нужен ответ на вопрос «что
 * он сделал» — и это ровно те файлы. Поэтому список стоит рядом с редактором,
 * а не только в переписке.
 */
import { parentOf } from '../../shared/paths';
import type { CommandRegistry } from '../core/commands';
import type { RunArtifacts } from '../core/artifacts';
import { basename, clear, h } from './dom';

export interface ArtifactsBlockDeps {
  artifacts: RunArtifacts;
  commands: CommandRegistry;
}

export interface ArtifactsBlock {
  element: HTMLElement;
}

/**
 * «Артефакты» — что агент предъявил в этом разговоре, рядом с деревом проекта.
 *
 * Карточка в ленте живёт один шаг: прокрутил переписку — и «что он сделал»
 * приходится собирать по кускам. Список тот же, но постоянный: свежие сверху,
 * щелчок — обычное открытие файла (`file.activate`), как из дерева.
 */
export function createArtifactsBlock(deps: ArtifactsBlockDeps): ArtifactsBlock {
  const list = h('div', { class: 'artifacts-list', role: 'list' });
  const count = h('span', { class: 'artifacts-count' });
  const element = h(
    'div',
    { class: 'artifacts' },
    h('div', { class: 'artifacts-head' }, h('span', { class: 'artifacts-title' }, 'Артефакты'), count),
    list,
  );

  const render = (): void => {
    const items = deps.artifacts.list();
    // Пусто — блока нет: постоянная пустая рамка только отнимает высоту у дерева.
    element.hidden = items.length === 0;
    count.textContent = String(items.length);
    clear(list);
    for (const item of items) {
      const row = h(
        'div',
        { class: 'artifact', role: 'listitem', title: item.path, tabindex: '0' },
        h('span', { class: 'artifact-name' }, basename(item.path)),
        h('span', { class: 'artifact-hint' }, item.note || parentOf(item.path)),
      );
      const activate = (): void => void deps.commands.execute('file.activate', item.path);
      row.addEventListener('click', activate);
      row.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        activate();
      });
      list.append(row);
    }
  };

  deps.artifacts.onChange(render);
  render();

  return { element };
}
