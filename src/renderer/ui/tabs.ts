import type { CommandRegistry } from '../core/commands';
import type { DocumentStore } from '../core/document-store';
import type { OpenEditors } from '../core/open-editors';
import { basename, clear, h, svgIcon } from './dom';

/**
 * Вкладка-спутник: не документ, но живёт в той же полосе. Сейчас это чат — он
 * открывается в области редактора как обычная вкладка и закрывается крестиком.
 */
export interface AuxiliaryTab {
  title: string;
  /** Вкладка есть в полосе: чат может жить и в боковой панели. */
  readonly visible: boolean;
  /** Активна ли она сейчас: тогда активного файла в полосе нет. */
  readonly active: boolean;
  activate(): void;
  close(): void;
}

export interface TabsDeps {
  openEditors: OpenEditors;
  documents: DocumentStore;
  commands: CommandRegistry;
  /** Вкладка-спутник появится в полосе, если она задана. */
  auxiliary?: AuxiliaryTab;
}

export interface Tabs {
  element: HTMLElement;
  /** Перерисовать полосу: спутник мог открыться, закрыться или стать активным. */
  refresh(): void;
}

/** Вкладки как в PyCharm: скруглённые, у активной — синяя полоса сверху. */
export function createTabs(deps: TabsDeps): Tabs {
  const element = h('div', { class: 'tabs' });

  /** Тот же зазор, что у отступа полосы: до него прокрутка доводит вкладку. */
  const TAB_GAP = 6;

  const render = (): void => {
    clear(element);
    const auxiliary = deps.auxiliary;
    const auxActive = auxiliary?.active === true;
    // Пока активна вкладка-спутник, ни один файл не выглядит открытым.
    const active = auxActive ? null : (deps.openEditors.active?.path ?? null);

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

    if (auxiliary?.visible) {
      const classes = ['tab', 'tab-auxiliary'];
      if (auxActive) classes.push('is-active');
      const tab = h(
        'div',
        { class: classes.join(' '), title: auxiliary.title },
        svgIcon('chat', 13),
        h('span', { class: 'tab-label' }, auxiliary.title),
        h(
          'button',
          {
            class: 'tab-close',
            type: 'button',
            title: 'Закрыть (чат вернётся в боковую панель)',
            onClick: (event: Event) => {
              event.stopPropagation();
              auxiliary.close();
            },
          },
          svgIcon('close', 11),
        ),
      );
      tab.addEventListener('click', () => auxiliary.activate());
      tab.addEventListener('auxclick', (event) => {
        if (event.button === 1) auxiliary.close();
      });
      element.appendChild(tab);
    }

    // Активная вкладка могла уехать за край — подкручиваем к ней, но без движения,
    // если она и так видна.
    element.querySelector('.tab.is-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    syncEdges();
  };

  /**
   * Края полосы: если вкладки не помещаются, край мягко уходит — обрезанная
   * вкладка тогда читается как «дальше есть ещё», а не как срезанная случайно.
   */
  const syncEdges = (): void => {
    const max = element.scrollWidth - element.clientWidth;
    element.classList.toggle('is-scrolled-start', element.scrollLeft > 1);
    element.classList.toggle('is-scrolled-end', max > 1 && element.scrollLeft < max - 1);
  };

  /**
   * Колесо докручивает полосу до границы вкладки: иначе она замирает посреди
   * вкладки и у края остаётся обрезанная половина. Своё докручивание нужно потому,
   * что полосу двигает наш обработчик колеса, а не браузерная прокрутка — на такие
   * сдвиги CSS-подлипание (`scroll-snap-type`) не действует.
   */
  let snapTimer = 0;
  const snapToTabEdge = (): void => {
    const strip = element.getBoundingClientRect();
    const max = element.scrollWidth - element.clientWidth;
    // Смещение вкладки в содержимом полосы: на экране это её левый край минус
    // отступ полосы, а отступ — тот же зазор, который оставляет прокрутка.
    const edges = [...element.querySelectorAll<HTMLElement>('.tab')].map((tab) =>
      Math.max(0, Math.min(tab.getBoundingClientRect().left - strip.left + element.scrollLeft - TAB_GAP, max)),
    );
    if (edges.length === 0) return;
    const nearest = edges.reduce((best, edge) =>
      Math.abs(edge - element.scrollLeft) < Math.abs(best - element.scrollLeft) ? edge : best,
    );
    element.scrollLeft = nearest;
  };

  element.addEventListener('scroll', syncEdges, { passive: true });

  // Ширина полосы меняется окном и панелями: без пересчёта край остался бы мягким,
  // даже когда вкладки снова помещаются целиком. `ResizeObserver` сообщает о размере
  // только вместе с отрисовкой, поэтому страхуемся обычным `resize` окна.
  new ResizeObserver(syncEdges).observe(element);
  window.addEventListener('resize', syncEdges);

  // Колесо мыши крутит полосу по горизонтали: вкладок бывает больше, чем помещается,
  // а вертикальной прокрутки в ней нет.
  element.addEventListener(
    'wheel',
    (event) => {
      if (event.deltaY === 0 || element.scrollWidth <= element.clientWidth) return;
      event.preventDefault();
      element.scrollLeft += event.deltaY;
      // Ждём, пока колесо остановится, и только тогда выравниваем.
      clearTimeout(snapTimer);
      snapTimer = window.setTimeout(() => {
        snapToTabEdge();
        syncEdges();
      }, 140);
    },
    { passive: false },
  );

  deps.openEditors.onDidChange(render);
  deps.documents.onDidChange(render);
  render();

  return { element, refresh: render };
}
