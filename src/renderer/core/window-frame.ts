import { PushTopic, type WindowState } from '../../shared/api';
import { h, svgIcon, type IconName } from '../ui/dom';
import type { RpcClient } from './rpc';

/**
 * Своя рамка окна: кнопки в шапке.
 *
 * Системных украшений у окна нет (`frame: false`), но за то, что обычно делает
 * оконный менеджер, отвечает сам Chromium: окно тянется за шапку через
 * `app-region: drag` в CSS, а за края растягивается нативно — как безрамочное.
 * Своих полос по краям поэтому нет: за них окно только меняло размер, но не
 * переезжало (позицию под Wayland задать нельзя), и верхний край «уезжал» вниз.
 * Что окно остаётся растягиваемым, стережёт `npm run smoke:window`.
 */
export class WindowFrame {
  private state: WindowState = {
    maximized: false,
    fullScreen: false,
    platform: 'linux',
    customControls: true,
  };

  private readonly controls = h('div', { class: 'window-controls' });
  private readonly minimizeButton: HTMLButtonElement;
  private readonly maximizeButton: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;

  /**
   * Значки кнопок берём у системы: в Plasma это шевроны (вниз — свернуть,
   * вверх — развернуть, двойной — восстановить), в остальных «− □ ✕».
   * Своя рамка не должна выбиваться из соседних окон рабочего стола.
   */
  private readonly systemGlyphs = (window.chui?.platform ?? '') === 'linux';

  constructor(
    private readonly rpc: RpcClient,
    controlsHost: HTMLElement,
    dragRegion: HTMLElement,
  ) {
    const minimize = h(
      'button',
      {
        class: 'window-btn',
        type: 'button',
        title: 'Свернуть',
        onClick: () => void closeSafe(this.rpc, 'window.minimize'),
      },
      svgIcon(this.glyph('minimize'), 14),
    );
    this.minimizeButton = minimize;
    this.maximizeButton = h(
      'button',
      { class: 'window-btn', type: 'button', title: 'Развернуть', onClick: () => void this.toggleMaximize() },
      svgIcon(this.glyph('maximize'), 14),
    );
    this.closeButton = h(
      'button',
      {
        class: 'window-btn is-close',
        type: 'button',
        title: 'Закрыть',
        onClick: () => void closeSafe(this.rpc, 'window.close'),
      },
      svgIcon('close', 13),
    );

    this.controls.append(this.minimizeButton, this.maximizeButton, this.closeButton);
    controlsHost.appendChild(this.controls);

    // Двойной клик по шапке разворачивает окно. На macOS это делает система,
    // к тому же область перетаскивания не отдаёт события в DOM.
    dragRegion.addEventListener('dblclick', (event) => {
      if (!this.state.customControls) return;
      if ((event.target as HTMLElement).closest('button')) return;
      void this.toggleMaximize();
    });

    rpc.onPush((message) => {
      if (message.topic !== PushTopic.WindowStateChanged) return;
      this.applyState(message.payload as WindowState);
    });
  }

  async refresh(): Promise<void> {
    try {
      this.applyState(await this.rpc.request('window.getState'));
    } catch (error) {
      console.error('[chui] не удалось получить состояние окна', error);
    }
  }

  private async toggleMaximize(): Promise<void> {
    this.applyState(await this.rpc.request('window.toggleMaximize'));
  }

  private applyState(state: WindowState): void {
    this.state = state;

    const root = document.documentElement;
    root.classList.toggle('is-mac', !state.customControls);
    root.classList.toggle('has-custom-frame', state.customControls);
    root.classList.toggle('is-maximized', state.maximized || state.fullScreen);

    this.controls.hidden = !state.customControls;

    this.minimizeButton.title = 'Свернуть';
    this.maximizeButton.title = state.maximized ? 'Восстановить' : 'Развернуть';
    this.maximizeButton.replaceChildren(svgIcon(this.glyph(state.maximized ? 'restore' : 'maximize'), 14));
  }

  /** Значок для роли кнопки: системный там, где система рисует шевроны. */
  private glyph(kind: 'minimize' | 'maximize' | 'restore'): IconName {
    if (!this.systemGlyphs) return kind;
    if (kind === 'minimize') return 'chevronDown';
    return kind === 'maximize' ? 'chevronUp' : 'chevronsUp';
  }
}

async function closeSafe(rpc: RpcClient, method: 'window.minimize' | 'window.close'): Promise<void> {
  await rpc.request(method).catch(() => undefined);
}
