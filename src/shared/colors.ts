export type ColorScheme = 'dark' | 'light';

/**
 * Цвет фона окна — единственное значение палитры, которое нужно main-процессу.
 *
 * `BrowserWindow` красит себя сам до первой отрисовки страницы, поэтому цвет
 * задаётся не в CSS, а в аргументах окна. Держать его литералом в двух местах
 * (`createAppWindow` и `applyTheme`) — верный способ развести их при смене
 * палитры, поэтому значение живёт здесь и импортируется обоими.
 *
 * Это ЗЕРКАЛО токенов `styles/theme.css`, а не второй источник правды: тёмное
 * значение повторяет `--element_background_2` (полотно и карточка, #252528),
 * светлое — `--main_background` (фон окна, #E4E4E7). Правка палитры — правка и
 * здесь; расхождение ловит тест `tests/theme.test.ts`.
 */
export const WINDOW_BACKGROUND: Record<ColorScheme, string> = {
  dark: '#252528',
  light: '#e4e4e7',
};

/** Фон окна под текущую схему системы. */
export function windowBackground(scheme: ColorScheme): string {
  return WINDOW_BACKGROUND[scheme];
}
