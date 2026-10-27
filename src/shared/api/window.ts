/* ── Окно ─────────────────────────────────────────────────────────────── */

/** Состояние окна нужно своей рамке: без неё не понять, что рисовать в кнопках. */
export interface WindowState {
  maximized: boolean;
  fullScreen: boolean;
  platform: string;
  /** На macOS остаются системные «светофоры», свои кнопки не нужны. */
  customControls: boolean;
}
