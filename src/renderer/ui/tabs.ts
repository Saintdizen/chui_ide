import type { CommandRegistry } from '../core/commands';
import type { DocumentStore } from '../core/document-store';
import type { OpenEditors } from '../core/open-editors';
import { basename, clear, h, svgIcon } from './dom';

export interface TabsDeps {
  openEditors: OpenEditors;
  documents: DocumentStore;
  commands: CommandRegistry;
}

/** Вкладки как в PyCharm: скруглённые, у активной — синяя полоса сверху. */
export function createTabs(deps: TabsDeps): HTMLElement {
  const element = h('div', { class: 'tabs' });

  const render = (): void => {
    clear(element);
    const active = deps.openEditors.active?.path ?? null;

    for (const path of deps.openEditors.paths) {
      const document = deps.documents.get(path);
      const classes = ['tab'];
      if (path === active) classes.push('is-active');
      // У изменённой вкладки крестик остаётся видимым: иначе точка правки
      // пряталась бы вместе с кнопкой закрытия.
      if (document?.dirty) classes.push('is-dirty');

      const tab = h(
        'div',
        { class: classes.join(' '), title: path },
        svgIcon('file', 13),
        h('span', { class: 'tab-label' }, basename(path)),
        h(
          'button',
          {
            class: 'tab-close',
            type: 'button',
            title: 'Закрыть (Ctrl+W)',
            onClick: (event: Event) => {
              event.stopPropagation();
              void deps.commands.execute('file.close', path);
            },
          },
          document?.dirty ? h('span', { class: 'tab-dirty' }) : null,
          svgIcon('close', 11),
        ),
      );

      tab.addEventListener('click', () => void deps.commands.execute('file.activate', path));
      tab.addEventListener('auxclick', (event) => {
        if (event.button === 1) void deps.commands.execute('file.close', path);
      });

      element.appendChild(tab);
    }

    // Активная вкладка могла уехать за край — подкручиваем к ней, но без движения,
    // если она и так видна.
    element.querySelector('.tab.is-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  // Колесо мыши крутит полосу по горизонтали: вкладок бывает больше, чем помещается,
  // а вертикальной прокрутки в ней нет.
  element.addEventListener(
    'wheel',
    (event) => {
      if (event.deltaY === 0 || element.scrollWidth <= element.clientWidth) return;
      event.preventDefault();
      element.scrollLeft += event.deltaY;
    },
    { passive: false },
  );

  deps.openEditors.onDidChange(render);
  deps.documents.onDidChange(render);
  render();

  return element;
}
