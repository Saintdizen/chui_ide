import { PushTopic, type WindowBounds, type WindowState } from '../../shared/api';
import { h, svgIcon, type IconName } from '../ui/dom';
import type { RpcClient } from './rpc';

const RESIZE_EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
type ResizeEdge = (typeof RESIZE_EDGES)[number];

/**
 * Своя рамка окна: кнопки в шапке и края для растягивания.
 *
 * Системных украшений у окна нет (`frame: false`), поэтому всё, что обычно
 * делает оконный менеджер, приходится делать самим. Перетаскивание берёт на себя
 * `app-region: drag` в CSS — его ведёт Chromium через оконный менеджер, поэтому
 * движение плавное. А края растягивания рисует этот класс: у безрамочного окна
 * на Linux системных краёв нет, и без них окно осталось бы фиксированного размера.
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
  private readonly edges: HTMLElement[] = [];

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

    this.attachResizeEdges();

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

    // Развёрнутое окно не тянут за края: их прячем вместе с кнопками.
    const edgesHidden = !state.customControls || state.maximized || state.fullScreen;
    for (const edge of this.edges) edge.hidden = edgesHidden;
  }

  /** Значок для роли кнопки: системный там, где система рисует шевроны. */
  private glyph(kind: 'minimize' | 'maximize' | 'restore'): IconName {
    if (!this.systemGlyphs) return kind;
    if (kind === 'minimize') return 'chevronDown';
    return kind === 'maximize' ? 'chevronUp' : 'chevronsUp';
  }

  private attachResizeEdges(): void {
    for (const edge of RESIZE_EDGES) {
      const element = h('div', { class: `resize-edge resize-edge-${edge}` });
      element.addEventListener('pointerdown', (event) => void this.startResize(edge, event));
      document.body.appendChild(element);
      this.edges.push(element);
    }
  }

  /**
   * Тянем за край: считаем новые размеры от положения курсора в начале жеста.
   * Зажатие по минимуму делает main — там же, где живут minWidth и minHeight.
   */
  private async startResize(edge: ResizeEdge, event: PointerEvent): Promise<void> {
    if (this.state.maximized || this.state.fullScreen) return;
    event.preventDefault();

    const start = await this.rpc.request('window.getBounds');
    const startX = event.screenX;
    const startY = event.screenY;

    const west = edge.includes('w');
    const north = edge.includes('n');
    const east = edge.includes('e');
    const south = edge.includes('s');

    let pending: WindowBounds = { ...start };
    let frame = 0;

    const onMove = (move: PointerEvent): void => {
      const dx = move.screenX - startX;
      const dy = move.screenY - startY;

      pending = {
        x: west ? start.x + dx : start.x,
        y: north ? start.y + dy : start.y,
        width: west ? start.width - dx : east ? start.width + dx : start.width,
        height: north ? start.height - dy : south ? start.height + dy : start.height,
      };

      // Кадр на жест: без этого на каждое движение мыши уходил бы запрос.
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        void this.rpc.request('window.setBounds', pending).catch(() => undefined);
      });
    };

    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (frame) cancelAnimationFrame(frame);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }
}

async function closeSafe(rpc: RpcClient, method: 'window.minimize' | 'window.close'): Promise<void> {
  await rpc.request(method).catch(() => undefined);
}
