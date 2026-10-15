import type { CommandRegistry } from '../core/commands';
import type { DocumentStore } from '../core/document-store';
import type { OpenEditors } from '../core/open-editors';
import { showContextMenu } from './context-menu';
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
  const element = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Открытые файлы' });

  /** Тот же зазор, что у отступа полосы: до него прокрутка доводит вкладку. */
  const TAB_GAP = 6;

  /**
   * Ход по полосе с клавиатуры: стрелки и Home/End переносят фокус и выбор на соседнюю
   * вкладку (выбор едет вместе с фокусом — так ждёт ролевая модель вкладок), Enter или
   * пробел открывают файл вкладки, Delete закрывает. Tab при этом один: в полосе
   * фокусируема только активная вкладка (`tabindex` выше).
   */
  const onTabKey = (event: KeyboardEvent, path: string): void => {
    const paths = [...element.querySelectorAll<HTMLElement>('.tab')];
    const index = paths.findIndex((node) => node.dataset.path === path);
    if (index < 0) return;

    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    const target =
      step !== 0 ? index + step : event.key === 'Home' ? 0 : event.key === 'End' ? paths.length - 1 : index;
    if (target !== index && target >= 0 && target < paths.length) {
      event.preventDefault();
      const next = paths[target]!;
      const nextPath = next.dataset.path;
      if (nextPath) void deps.commands.execute('file.activate', nextPath);
      next.focus();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      void deps.commands.execute('file.activate', path);
      return;
    }
    if (event.key === 'Delete') {
      event.preventDefault();
      void deps.commands.execute('file.close', path);
    }
  };

  const render = (): void => {
    // Полоса пересобирается целиком: узел с фокусом исчезает, и без переноса фокуса
    // он упал бы на `body` — человек, идущий по вкладкам стрелками, терял бы место.
    const hadFocus = element.contains(document.activeElement);
    clear(element);
    const auxiliary = deps.auxiliary;
    const auxActive = auxiliary?.active === true;
    // Пока активна вкладка-спутник, ни один файл не выглядит открытым.
    const active = auxActive ? null : (deps.openEditors.active?.path ?? null);

    // Закреплённые — левее прочих: их место не «съедает» предпросмотр, и так видно,
    // что они не уедут. Порядок внутри группы прежний (сортировка устойчива).
    const paths = [...deps.openEditors.paths].sort(
      (a, b) => Number(deps.openEditors.isPinned(b)) - Number(deps.openEditors.isPinned(a)),
    );
    for (const path of paths) {
      const document = deps.documents.get(path);
      const pinned = deps.openEditors.isPinned(path);
      const classes = ['tab'];
      if (path === active) classes.push('is-active');
      // У изменённой вкладки крестик остаётся видимым: иначе точка правки
      // пряталась бы вместе с кнопкой закрытия.
      if (document?.dirty) classes.push('is-dirty');
      // Закреплённая — значок булавки вместо листа; предпросмотр — курсивом.
      if (pinned) classes.push('is-pinned');
      if (deps.openEditors.isPreview(path)) classes.push('is-preview');

      const tab = h(
        'div',
        {
          class: classes.join(' '),
          title: path,
          // Полоса — это вкладки: роль, выбор и ход стрелками. Внутри вкладки крестик
          // остаётся настоящей кнопкой, и это её собственное место (см. ниже).
          role: 'tab',
          dataset: { path },
          'aria-selected': path === active ? 'true' : 'false',
          // Ходить по полосе — Tab (встаёт на активной) плюс стрелки внутри (см. `onTabKey`).
          tabindex: path === active ? '0' : '-1',
        },
        pinned ? svgIcon('pin', 13) : svgIcon('file', 13),
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
      // Стрелки ходят по полосе, как в списке вкладок: фокус и выбор едут вместе.
      tab.addEventListener('keydown', (event) => onTabKey(event, path));
      // Правый клик — то, чего не сделать перетаскиванием: закрепить вкладку или
      // закрыть соседей. Само действие — команда: одно и то же из меню и палитры.
      tab.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        showContextMenu(
          [
            {
              label: pinned ? 'Открепить вкладку' : 'Закрепить вкладку',
              onSelect: () => void deps.commands.execute('file.togglePin', path),
            },
            { separator: true },
            // Сохранение под другим именем — из меню самой вкладки: файл уже открыт,
            // искать его команду в палитре незачем.
            {
              label: 'Сохранить как…',
              hint: 'Ctrl+Shift+S',
              onSelect: () => void deps.commands.execute('file.saveAs', path),
            },
            // Буфер мог разойтись с файлом — его переписал другой инструмент. Возврат
            // к версии на диске рядом: искать эту команду в палитре незачем.
            {
              label: 'Перечитать с диска',
              onSelect: () => void deps.commands.execute('file.revertFromDisk', path),
            },
            { separator: true },
            { label: 'Закрыть', hint: 'Ctrl+W', onSelect: () => void deps.commands.execute('file.close', path) },
            { label: 'Закрыть другие', onSelect: () => void deps.commands.execute('file.closeOthers', path) },
          ],
          event.clientX,
          event.clientY,
        );
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
    const activeTab = element.querySelector<HTMLElement>('.tab.is-active');
    activeTab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (hadFocus) activeTab?.focus();
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
  // Сохранение не меняет текст, но снимает пометку правки: точка на вкладке
  // обязана погаснуть сразу, а не по событию наблюдателя за файлом.
  deps.documents.onDidChangeDirty(render);
  render();

  return { element, refresh: render };
}
