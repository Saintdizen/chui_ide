/**
 * Оформление меню Monaco по правой кнопке — из попапов редактора только оно
 * и живёт в shadow root.
 *
 * Monaco рисует их внутри собственного теневого корня (`div.shadow-root-host`),
 * поэтому обычные наши стили туда не доходят: страница за границу корня не
 * заглядывает, а переменные через неё передаются — только значения, но не правила.
 * В теневом корне живёт только меню по правой кнопке: палитра, поиск, подсказки и
 * окно параметров рисуются в обычном DOM редактора, и их форма — в `styles/monaco.css`.
 * Цвета задаёт тема (`core/theme.ts`), а здесь лежит то, что относится только к меню.
 *
 * Меню приведено к виду наших попапов (`.select-popup`/`.context-menu` в main.css):
 * тот же отступ контейнера 4 px, пункт с отступами `5px 9px` и радиусом 8 px,
 * шрифт 12 px, та же подсказка сочетания клавиш и тот же разделитель. Monaco задаёт
 * противоположное — высоту пункта 24 px, отступ текста `0 2em` (26 px от края) и
 * шрифт 13 px, — и вставляет свои правила в корень позже нашего стиля, поэтому
 * перекрываем их удвоенным селектором и `!important` там, где он есть у Monaco
 * (разделитель). Так же поступает и сам Monaco в правилах повышенного контраста.
 *
 * Без блюра и прозрачности меню — плотная непрозрачная поверхность (в отличие от
 * наших попапов со стеклом): тему Monaco собирает из сплошных цветов, а блюр над
 * живым редактором пришлось бы пересчитывать на каждой правке. Слой держат рамка и
 * тень. Фон задаём здесь явно: цвета темы Monaco объявлены
 * на самом редакторе, а меню рисуется в теневом корне рядом с `body`, вне
 * редактора — его переменные туда не доходят, и меню оставалось полностью
 * прозрачным. Теневые корни открытые, а хосты создаются лениво: за DOM следит
 * наблюдатель.
 */
const STYLE_ID = 'chui-monaco-popovers';

const CSS = `
  /* Появление всплывающего слоя — кросс-фейд, как у наших попапов. Копия
     @keyframes из main.css не лишняя: внутри теневого корня надёжнее держать её
     рядом с правилом, которое её просит. */
  @keyframes popup-fade {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  /* Правила страницы в теневой корень не доходят, поэтому «уменьшить движение»
     учитываем здесь сами: меню появляется кросс-фейдом — он и есть облегчённая
     форма появления (HIG: «cross-fade instead of slide»). */
  @media (prefers-reduced-motion: reduce) {
    .monaco-menu.monaco-menu {
      animation-name: popup-fade;
      animation-duration: var(--motion_base);
    }
  }

  /* Палитры, поиска, подсказок и окна параметров здесь нет и быть не должно: они
     рисуются в обычном DOM редактора, их форма — в styles/monaco.css. В теневом
     корне эти селекторы не совпадали ни с чем (по живому DOM .monaco-hover есть
     только в обычном DOM, а в корне — одно меню), и правила были мёртвыми. */

  /* ── меню: как наш дропдаун селекта ───────────────────────────────────────── */

  /* Контейнер: отступ 4 px, шрифт интерфейса и появление той же анимацией, что
     у наших попапов. Свой шрифт нужен потому, что меню наследует стек редактора
     (системный/моноширинный) — от него зависит и вид текста, и высота пункта.
     Фон задаём явно: переменные темы объявлены на редакторе, а меню рисуется
     в теневом корне вне его — без своей заливки оно остаётся прозрачным. */
  .monaco-menu.monaco-menu {
    background: var(--popup_background);
    padding: 4px !important;
    min-width: 210px;
    font-family: var(--font_ui);
    font-size: var(--font_labels_size);
    animation: popup-fade var(--motion_base) var(--motion_ease);
  }

  /* Панель действий добавляет по 4 px сверху и снизу, а обёртка каждого пункта —
     ещё по 4 px: вместе с отступом контейнера получалось 8 px перед первым пунктом
     и столько же между пунктами. */
  .monaco-menu.monaco-menu .monaco-action-bar.vertical,
  .monaco-menu.monaco-menu .monaco-action-bar.vertical .action-item {
    padding: 0 !important;
  }

  /* Пункт: отступы, зазор и радиус как у .context-item, высота — по содержимому. */
  .monaco-menu.monaco-menu .monaco-action-bar.vertical .action-menu-item {
    height: auto !important;
    margin: 0 !important;
    padding: var(--control_padding_sm) 9px !important;
    gap: 12px;
    border-radius: var(--radius_sm) !important;
  }

  /* Подпись и сочетание клавиш: убираем отступ Monaco (0 2em), иначе текст
     уезжает от края, и возвращаем сочетанию вид нашей подсказки. Высоту строки
     берём из токена интерфейса: у Monaco она равна нормальной (15 px вместо наших
     17.4), и пункт выходил на 5 px ниже. */
  .monaco-menu.monaco-menu .monaco-action-bar.vertical .action-label:not(.separator),
  .monaco-menu.monaco-menu .monaco-action-bar.vertical .keybinding {
    padding: 0 !important;
    max-height: none;
    font-size: inherit;
    line-height: var(--line_height_ui) !important;
  }

  .monaco-menu.monaco-menu .monaco-action-bar.vertical .keybinding {
    flex: 0 0 auto;
    margin-left: auto;
    font-size: 11px;
    color: var(--text_color_tertiary);
  }

  /* Подсказка сочетания: при наведении она, как и в наших меню, светлеет вместе
     с текстом пункта и чуть притухает. Селектор с полным путём: у Monaco своё
     правило на этот случай, и совпадать с ним по специфичности нельзя. */
  .monaco-menu.monaco-menu .monaco-action-bar.vertical .action-menu-item:hover .keybinding,
  .monaco-menu.monaco-menu .monaco-action-bar.vertical .action-item.focused .keybinding {
    color: inherit !important;
    opacity: 0.7 !important;
  }

  /* Наведение и курсор клавиатуры — та же заливка, что у пунктов наших меню. */
  .monaco-menu.monaco-menu .monaco-action-bar.vertical .action-item.focused > .action-menu-item,
  .monaco-menu.monaco-menu .monaco-action-bar.vertical .action-menu-item:hover {
    background: var(--element_background_hover) !important;
    color: var(--text_color) !important;
  }

  /* Разделитель: 1 px с отступами как у .context-separator. */
  .monaco-menu.monaco-menu .monaco-action-bar.vertical .action-label.separator {
    width: auto !important;
    height: 1px !important;
    margin: 4px 6px !important;
    border-bottom: none !important;
    padding: 0 !important;
    background: var(--separator_color);
  }
`;

export function styleMonacoPopovers(): void {
  const apply = (root: ShadowRoot): void => {
    const existing = root.querySelector<HTMLStyleElement>(`#${STYLE_ID}`);
    if (existing) {
      // Monaco вставляет свои стили при каждом показе виджета, а при равной
      // специфичности выигрывает последнее правило. Поэтому держим наш стиль
      // последним: перестал быть последним — переносим в конец.
      if (root.lastElementChild !== existing) root.append(existing);
      return;
    }
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    root.append(style);
  };

  const scan = (): void => {
    for (const host of document.querySelectorAll('.shadow-root-host')) {
      if (host.shadowRoot) apply(host.shadowRoot);
    }
  };

  scan();

  // Редактор и экран сравнения создают свои теневые корни не сразу, а по мере
  // надобности (палитра и меню появляются при первом показе) — следим за DOM.
  const observer = new MutationObserver(scan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
}
