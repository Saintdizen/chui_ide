/**
 * Адаптивная раскладка панелей: какие из них показывать при заданной ширине окна.
 *
 * Логика чистая — ни DOM, ни Monaco: окно отдаёт ширину, модуль говорит, что
 * сделать с панелями. Проверяется юнит-тестом (`tests/panel-layout.test.ts`),
 * а `app.ts` только слушает `resize` и применяет решение.
 *
 * Правило поведения: раскладка меняется ТОЛЬКО на переходе между полосами
 * ширины. Внутри полосы модуль молчит — поэтому панель, открытую вручную на узком
 * окне, не схлопывает следующее же событие `resize`.
 */

/** Ширина, ниже которой обе боковые панели отбирают у редактора слишком много. */
export const COMPACT_WIDTH = 1000;

/** Ширина, начиная с которой помещаются обе панели и остаётся место редактору. */
export const WIDE_WIDTH = 1200;

/** Полоса ширины окна: узкая, обычная, широкая. */
export type PanelBand = 'compact' | 'regular' | 'wide';

export interface PanelVisibility {
  sidebar: boolean;
  right: boolean;
}

/** Полоса по ширине окна. Пороги задают, когда панель уступает место редактору. */
export function panelBand(width: number): PanelBand {
  if (width < COMPACT_WIDTH) return 'compact';
  if (width < WIDE_WIDTH) return 'regular';
  return 'wide';
}

/** Что полоса показывает сама, если человек не распорядился иначе. */
export function autoPanels(band: PanelBand): PanelVisibility {
  switch (band) {
    case 'compact':
      // Обе панели уходят: редактор важнее, а панель открывается кнопкой шапки.
      return { sidebar: false, right: false };
    case 'regular':
      // Боковая (дерево проекта) нужна чаще правой (ассистент и сравнение).
      return { sidebar: true, right: false };
    case 'wide':
      // Места хватает на всё: широкий монитор показывает обе панели.
      return { sidebar: true, right: true };
  }
}

/**
 * Держит соответствие «ширина окна → видимость панелей», не споря с человеком.
 *
 * Панель, свёрнутую автопоказом, при расширении возвращаем; закрытую вручную —
 * нет. Различает их флаг: свернули мы — значит вернём, а если панель видна и мы её
 * не трогали, метка снимается и автопоказ за неё больше не отвечает.
 */
export class AutoPanelLayout {
  private band: PanelBand | null = null;
  /** Панели, свёрнутые автопоказом, а не человеком. */
  private hiddenSidebar = false;
  private hiddenRight = false;

  /**
   * Решение по ширине `width` при текущей видимости `current`.
   * `null` — менять нечего: полоса та же либо раскладка уже совпала.
   */
  update(width: number, current: PanelVisibility): PanelVisibility | null {
    const band = panelBand(width);
    if (band === this.band) return null;
    this.band = band;

    const wanted = autoPanels(band);
    let sidebar = current.sidebar;
    let right = current.right;

    if (!wanted.sidebar && current.sidebar) {
      sidebar = false;
      this.hiddenSidebar = true;
    } else if (wanted.sidebar && !current.sidebar && this.hiddenSidebar) {
      sidebar = true;
      this.hiddenSidebar = false;
    }

    if (!wanted.right && current.right) {
      right = false;
      this.hiddenRight = true;
    } else if (wanted.right && !current.right && this.hiddenRight) {
      right = true;
      this.hiddenRight = false;
    }

    // Видимая панель, которую мы не сворачивали, не «наша»: метку снимаем, иначе
    // она всплывёт позже и вернёт панель, закрытую человеком.
    if (sidebar) this.hiddenSidebar = false;
    if (right) this.hiddenRight = false;

    return sidebar === current.sidebar && right === current.right ? null : { sidebar, right };
  }
}
