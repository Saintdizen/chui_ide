/**
 * Адаптивная раскладка панелей: какие из них показывать при заданной ширине окна.
 *
 * Логика чистая — только числа: окно отдаёт ширину, модуль говорит, что
 * сделать с панелями. Проверяется юнит-тестом (`tests/panel-layout.test.ts`),
 * а `app.ts` только слушает `resize` и применяет решение.
 *
 * Правило поведения: раскладка меняется ТОЛЬКО на переходе между полосами
 * ширины. Внутри полосы модуль молчит — поэтому панель, открытую вручную на узком
 * окне, не схлопывает следующее же событие `resize`.
 */

/**
 * Ширина, ниже которой обе боковые панели отбирают у редактора слишком много.
 *
 * Ниже этого порога окно и впрямь не для трёх колонок. Но планшетный режим оконных
 * менеджеров (плитка в половину 1920-экрана) даёт ровно ~960 px: на прежнем пороге
 * 1000 такое окно считалось «узким», и прилипание к краю свернуло бы проводник,
 * который в нём прекрасно помещается. Источник порога — `minWidth` окна: уже него
 * окно не сделаешь, значит и прятать панели не из-за чего.
 */
export const COMPACT_WIDTH = 820;

/** Ширина, начиная с которой помещаются обе панели и остаётся место редактору. */
export const WIDE_WIDTH = 1200;

/**
 * Ниже этого замера ширину нельзя считать настоящей: окно свёрнуто, прячется,
 * либо композитор-плитка ещё не отдал размер. Решение по такой ширине свернуло
 * бы панели без всякой причины.
 */
export const MIN_TRUSTED_WIDTH = 400;

/** Полоса ширины окна: узкая, обычная, широкая. */
export type PanelBand = 'compact' | 'regular' | 'wide';

export interface PanelVisibility {
  sidebar: boolean;
  right: boolean;
}

/** Видимость трёх панелей, между которыми делится ширина окна. */
export interface PanelState extends PanelVisibility {
  /** Область редактора: файлы, вкладки-страницы, разметка. */
  editor: boolean;
}

/** Намерение человека: что именно он переключил, остальное остаётся как было. */
export type PanelIntent = Partial<PanelState>;

/**
 * Видимость панелей после намерения — с одним инвариантом: скрытый редактор
 * оставляет окно без содержимого, поэтому правую панель (ассистент, сравнение)
 * он держит видимой.
 *
 * Отсюда две стороны одного правила:
 *   — свёрнуть правую при скрытом редакторе нельзя — намерение отклоняется;
 *   — скрыть редактор при уже свёрнутой правой можно, но правая вернётся: иначе
 *     человек остался бы с пустым окном и ни одного повода туда смотреть.
 *
 * Боковую (оглавление проекта) можно сворачивать всегда: без неё содержимое есть —
 * это и есть редактор.
 */
export function applyPanelIntent(state: PanelState, intent: PanelIntent): PanelState {
  const next: PanelState = { ...state, ...intent };
  if (!next.editor) next.right = true;
  return next;
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
    // Неправдоподобная ширина (окно свёрнуто, переезд между мониторами, плитка
    // до первого замера): полоса такой ширины ни о чём не говорит, а решение,
    // принятое по нулю, свернуло бы панели и не вернуло их без расширения окна.
    // Ждём настоящего размера.
    if (width < MIN_TRUSTED_WIDTH) return null;
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

  /**
   * Восстановление макета после запуска: запомнить полосу, но ничего не решать.
   *
   * Макет уже пришёл из настроек — человек расставил панели в прошлой сессии,
   * и первый расчёт по ширине не повод их переигрывать: при узком окне автопоказ
   * свернул бы обе, и «сохранённый макет» оказался бы ложью.
   */
  restore(width: number, current: PanelVisibility): void {
    this.band = width >= MIN_TRUSTED_WIDTH ? panelBand(width) : null;
    if (current.sidebar) this.hiddenSidebar = false;
    if (current.right) this.hiddenRight = false;
  }
}
