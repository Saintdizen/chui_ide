import { h } from './dom';

/**
 * Подсказки приложения вместо системных.
 *
 * Атрибут `title` рисует СИСТЕМНУЮ подсказку: у неё чужой шрифт и рамка, своя
 * задержка, а на части платформ она появляется отдельным окном поверх интерфейса
 * в оформлении рабочего стола. Нам это не нужно — подсказка должна читаться как
 * один из слоёв IDE.
 *
 * Переодевать все места с `title` не придётся: подсказку рисует ОДИН слой на всю
 * программу. Наведение ловим на документе, у элемента с `title` на время показа
 * атрибут снимаем (иначе поверх нашей вылезла бы системная) и возвращаем, как
 * только курсор ушёл. Отсюда и польза: новая кнопка с `title` показывает свою
 * подсказку сама, подключать к ней ничего не надо.
 *
 * Модуль ничего не знает о разметке и работает по документу целиком, поэтому
 * вызывается один раз при старте окна (см. `app.ts` и `ui/launcher.ts`).
 */

/** Задержка перед показом: подсказка не должна мигать при проходе курсором. */
const SHOW_DELAY_MS = 450;
/** Зазор между элементом и подсказкой. */
const GAP_PX = 6;
/** Поле от края окна: подсказка не липнет к самому краю. */
const EDGE_PX = 4;

/** Кто показывает подсказку сейчас и какой `title` у него был снят. */
interface ShownTooltip {
  element: HTMLElement;
  title: string;
}

/** Прямоугольник: место, которое занимает подсказка. */
interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Сцена встроенного браузера, если страница показана прямо сейчас.
 *
 * Страница — не элемент документа, а отдельный слой окна (`WebContentsView`
 * в `main/browser/panel.ts`), и лежит он ПОВЕРХ DOM. Значит любая подсказка,
 * попавшая в этот прямоугольник, окажется под страницей: на экране видна только
 * та её часть, что высунулась за край сцены.
 */
function pageStage(): Box | null {
  const stage = document.querySelector('.browser-view:not([hidden]) .browser-stage');
  if (!(stage instanceof HTMLElement)) return null;
  const box = stage.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return null;
  return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
}

/** Пересекаются ли прямоугольники: касание границ не в счёт. */
function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

export function installTooltips(): void {
  // Повторный вызов (горячая перезагрузка) не должен завести второй слой.
  if (document.querySelector('.app-tooltip')) return;

  const node = h('div', { class: 'app-tooltip', role: 'tooltip', hidden: true });
  document.body.appendChild(node);

  let shown: ShownTooltip | null = null;
  let pending: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending = null;
  };

  /** Убрать подсказку и вернуть атрибут: снят он был только на время показа. */
  const hide = (): void => {
    cancel();
    if (shown) {
      // Возвращаем, лишь если атрибут не выставили заново: иначе перетёрли бы
      // подсказку, которую код обновил, пока курсор стоял на элементе.
      if (!shown.element.hasAttribute('title')) shown.element.setAttribute('title', shown.title);
      shown = null;
    }
    node.hidden = true;
  };

  /**
   * Поставить подсказку под элементом; у нижнего края окна — над ним.
   *
   * Третье правило важнее привычного «снизу»: снизу от кнопок шапки вкладки
   * браузера лежит страница, а она — слой окна поверх DOM. Подсказка под такой
   * кнопкой была видна только хвостом, высунувшимся за край страницы. Поэтому
   * место, накрытое сценой, не годится, даже если формально влезает в окно.
   */
  const place = (target: HTMLElement): void => {
    const rect = target.getBoundingClientRect();
    // Замер держим за краем окна: размеры настоящие, а прыжка из угла не видно.
    node.style.left = `${-EDGE_PX - 10000}px`;
    node.style.top = '0px';
    const size = node.getBoundingClientRect();

    const centred = rect.left + rect.width / 2 - size.width / 2;
    const left = Math.max(EDGE_PX, Math.min(centred, window.innerWidth - size.width - EDGE_PX));
    const boxAt = (top: number): Box => ({ left, top, right: left + size.width, bottom: top + size.height });

    const below = rect.bottom + GAP_PX;
    const above = rect.top - GAP_PX - size.height;
    const inWindow = (top: number): boolean => top >= EDGE_PX && top + size.height <= window.innerHeight - EDGE_PX;

    const stage = pageStage();
    const fits = (top: number): boolean => {
      if (!inWindow(top)) return false;
      const box = boxAt(top);
      return stage === null || !overlaps(box, stage);
    };

    // Снизу — только если там нет страницы; иначе сверху; не вышло ни там, ни там —
    // снизу, как раньше (в худшем случае подсказка частично под страницей).
    const top = fits(below) ? below : fits(above) ? above : below;

    node.style.left = `${Math.round(left)}px`;
    node.style.top = `${Math.round(top)}px`;
  };

  const show = (target: HTMLElement, title: string): void => {
    target.removeAttribute('title');
    shown = { element: target, title };
    node.textContent = title;
    node.hidden = false;
    place(target);
  };

  /** Ближайший элемент с непустым `title` — от узла под курсором и выше. */
  const holder = (target: EventTarget | null): HTMLElement | null => {
    if (!(target instanceof Element)) return null;
    // Свою же подсказку за цель не считаем: у неё наведение отключено (`pointer-events`).
    if (node.contains(target)) return null;
    const found = target.closest('[title]');
    if (!(found instanceof HTMLElement)) return null;
    return (found.getAttribute('title') ?? '').length > 0 ? found : null;
  };

  document.addEventListener(
    'mouseover',
    (event) => {
      const found = holder(event.target);
      if (!found) {
        hide();
        return;
      }
      // Курсор ходит внутри того же элемента (по его детям) — отсчёт не перезапускаем.
      if (pending === found || shown?.element === found) return;
      hide();
      pending = found;
      timer = setTimeout(() => {
        timer = null;
        const target = pending;
        pending = null;
        // За время задержки элемент мог уехать из документа — показывать нечего.
        if (!target?.isConnected) return;
        const title = target.getAttribute('title') ?? '';
        if (title.length > 0) show(target, title);
      }, SHOW_DELAY_MS);
    },
    true,
  );

  document.addEventListener(
    'mouseout',
    (event) => {
      const active = shown?.element ?? pending;
      if (!active) return;
      // Ушли на ребёнка того же элемента — это не уход.
      if (event.relatedTarget instanceof Node && active.contains(event.relatedTarget)) return;
      hide();
    },
    true,
  );

  // Подсказка не должна пережить нажатие, прокрутку и смену кадра: она привязана
  // к месту элемента, а место вот-вот изменится.
  document.addEventListener('mousedown', hide, true);
  document.addEventListener('keydown', hide, true);
  document.addEventListener('wheel', hide, { capture: true, passive: true });
  document.addEventListener('scroll', hide, { capture: true, passive: true });
  window.addEventListener('resize', hide);
  window.addEventListener('blur', hide);
}
