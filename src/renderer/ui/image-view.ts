import type { ViewImage } from '../../shared/api';
import { canRenderImageMime, imageFormatLabel, isImagePath } from '../../shared/images';
import type { RpcClient } from '../core/rpc';
import { basename, formatBytes, h, svgIcon } from './dom';

/**
 * Вьюер изображений: показывает картинку там, где обычно текст.
 *
 * Это не редактор и не вкладка: вкладка принадлежит документу, а картинку текстом
 * не выразить. Вьюер ложится поверх области редактора (как экран сравнения) и
 * показывается, когда активная вкладка — изображение. Вкладку при этом заводит
 * приложение (документ-заглушка), чтобы полоса вкладок, дерево и статусбар вели
 * себя как с обычным файлом.
 *
 * Данные читает main и отдаёт готовым data-URL (`workspace.readImage`) — renderer
 * файловой системы не видит. Прочитанное помним по пути: переключение между
 * вкладками не должно гонять base64 через IPC снова.
 */
export interface ImageView {
  element: HTMLElement;
  /** Показать картинку. Уже показанная не перечитывается. */
  show(path: string): void;
  hide(): void;
  /** Открыта ли сейчас картинка (а не пустой вьюер). */
  readonly isOpen: boolean;
  /** Что показано — чтобы не перезагружать ту же картинку. */
  readonly path: string | null;
  /** Забыть прочитанное: файл закрыли или изменился. */
  forget(path: string): void;
}

export interface ImageViewDeps {
  rpc: RpcClient;
  /** Сообщить о сбое чтения (нет файла, слишком большой, не картинка). */
  notify: (message: string) => void;
}

/** Границы масштаба: мельче 10 % и крупнее 32× смысла нет. */
const MIN_SCALE = 0.1;
const MAX_SCALE = 32;
/** Шаг кнопок «＋» и «−» и шаг колеса. */
const SCALE_STEP = 1.25;

export function createImageView(deps: ImageViewDeps): ImageView {
  const title = h('span', { class: 'image-title' });
  const meta = h('span', { class: 'image-meta' });
  const zoomLabel = h('span', { class: 'image-zoom-label' });

  /** Масштаб в долях от натурального размера; `null` — «вписать в окно». */
  let scale: number | null = null;
  let natural = { width: 0, height: 0 };
  let open = false;
  let currentPath: string | null = null;

  const image = h('img', { class: 'image-picture', alt: '', draggable: false });
  const placeholderTitle = h('p', { class: 'image-placeholder-title' });
  const placeholderHint = h('p', { class: 'image-placeholder-hint' });
  const placeholder = h(
    'div',
    { class: 'image-placeholder', hidden: true },
    svgIcon('image', 28),
    placeholderTitle,
    placeholderHint,
  );
  const stage = h('div', { class: 'image-stage' }, image, placeholder);

  /** Прочитанные картинки по пути: переключение вкладок не гоняет base64 заново. */
  const cache = new Map<string, ViewImage>();

  const applyScale = (): void => {
    if (scale === null) {
      // «Вписать»: картинка не крупнее области, но и не растягивается мельче исходной.
      image.style.maxWidth = '100%';
      image.style.maxHeight = '100%';
      image.style.width = 'auto';
      image.style.height = 'auto';
      zoomLabel.textContent = 'вписано';
      return;
    }
    image.style.maxWidth = 'none';
    image.style.maxHeight = 'none';
    image.style.width = natural.width > 0 ? `${Math.round(natural.width * scale)}px` : 'auto';
    image.style.height = 'auto';
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;
  };

  const showMeta = (path: string, bytes: number, dimensions: { width: number; height: number }): void => {
    const label = imageFormatLabel(path);
    const size = dimensions.width > 0 ? `${dimensions.width} × ${dimensions.height}` : null;
    const parts = [label, size, formatBytes(bytes)];
    meta.textContent = parts.filter((part) => part !== null).join(' · ');
  };

  const zoomBy = (factor: number): void => {
    if (natural.width === 0) return;
    const base = scale ?? fitScale();
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, base * factor));
    scale = next;
    applyScale();
  };

  /** Доля, при которой картинка ровно помещается в область (только для перехода от «вписать»). */
  const fitScale = (): number => {
    const rect = stage.getBoundingClientRect();
    if (natural.width === 0 || rect.width === 0 || rect.height === 0) return 1;
    return Math.min(1, rect.width / natural.width, rect.height / natural.height);
  };

  const setFit = (): void => {
    scale = null;
    applyScale();
    stage.scrollTop = 0;
    stage.scrollLeft = 0;
  };

  const setActual = (): void => {
    scale = 1;
    applyScale();
  };

  const zoomIn = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Крупнее (Ctrl+колесо)', onClick: () => zoomBy(SCALE_STEP) },
    svgIcon('plus', 14),
  );
  const zoomOut = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Мельче (Ctrl+колесо)', onClick: () => zoomBy(1 / SCALE_STEP) },
    svgIcon('minus', 14),
  );
  const fitButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Вписать в окно', onClick: setFit },
    svgIcon('fit', 14),
  );
  const actualButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Реальный размер (1:1)', onClick: setActual },
    h('span', { class: 'image-actual' }, '1:1'),
  );

  /** Масштаб и «1:1» имеют смысл только у показанной картинки. */
  const setZoomEnabled = (enabled: boolean): void => {
    zoomOut.disabled = !enabled;
    zoomIn.disabled = !enabled;
    actualButton.disabled = !enabled;
    fitButton.disabled = !enabled;
    if (!enabled) zoomLabel.textContent = '';
  };

  /** Заглушка вместо картинки: формат, который движок не рисует, или сбой чтения. */
  const showPlaceholder = (titleText: string, hintText: string): void => {
    image.hidden = true;
    image.removeAttribute('src');
    placeholderTitle.textContent = titleText;
    placeholderHint.textContent = hintText;
    placeholder.hidden = false;
    setZoomEnabled(false);
  };

  const element = h(
    'div',
    { class: 'image-view', hidden: true },
    h(
      'div',
      { class: 'image-header' },
      svgIcon('image', 14),
      title,
      meta,
      h('div', { class: 'image-header-spacer' }),
      zoomLabel,
      zoomOut,
      zoomIn,
      actualButton,
      fitButton,
    ),
    stage,
  );

  image.addEventListener('load', () => {
    natural = { width: image.naturalWidth, height: image.naturalHeight };
    applyScale();
  });

  // Файл прочитан, но декодировать не удалось: повреждён или формат на границе
  // поддержки. Показываем то же объяснение, что и для неотрисовываемых форматов.
  image.addEventListener('error', () => {
    if (!open || currentPath === null) return;
    showPlaceholder(`${imageFormatLabel(currentPath)} не читается`, 'Файл повреждён или формат не поддерживается.');
  });

  // Ctrl+колесо — привычный жест масштабирования. Без Ctrl колесо оставляем прокрутке:
  // большая картинка чаще прокручивается, чем масштабируется.
  stage.addEventListener(
    'wheel',
    (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      zoomBy(event.deltaY < 0 ? SCALE_STEP : 1 / SCALE_STEP);
    },
    { passive: false },
  );

  const showError = (path: string, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    deps.notify(`Не удалось открыть изображение: ${basename(path)} — ${message}`);
  };

  const render = (path: string, data: ViewImage): void => {
    currentPath = path;
    title.textContent = basename(path);
    title.title = path;
    natural = { width: 0, height: 0 };
    scale = null;
    element.hidden = false;
    open = true;

    // Формат, который движок не декодирует (TIFF, HEIC): показываем объяснение,
    // а не «битую» рамку — в `<img>` он всё равно не отрисуется.
    if (!canRenderImageMime(data.mime)) {
      showMeta(path, data.bytes, natural);
      showPlaceholder(`${imageFormatLabel(path)} не отображается`, 'Этот формат встроенный движок не рисует.');
      return;
    }

    placeholder.hidden = true;
    image.hidden = false;
    setZoomEnabled(true);
    image.alt = basename(path);
    image.src = data.dataUrl;
    showMeta(path, data.bytes, natural);
    applyScale();
  };

  return {
    element,

    show(path: string): void {
      if (currentPath === path && open) return;
      if (!isImagePath(path)) return;

      const cached = cache.get(path);
      if (cached) {
        render(path, cached);
        return;
      }
      // Пока грузим, показываем шапку с именем: пустой экран без подписи выглядит как сбой.
      currentPath = path;
      title.textContent = basename(path);
      title.title = path;
      meta.textContent = '…';
      image.hidden = false;
      placeholder.hidden = true;
      setZoomEnabled(false);
      image.removeAttribute('src');
      element.hidden = false;
      open = true;

      void deps.rpc
        .request('workspace.readImage', { path })
        .then((data) => {
          cache.set(path, data);
          // Пока читали, могли переключиться на другую вкладку — тогда не подменяем.
          if (currentPath === path) render(path, data);
        })
        .catch((error) => {
          open = false;
          element.hidden = true;
          showError(path, error);
        });
    },

    hide(): void {
      open = false;
      currentPath = null;
      element.hidden = true;
    },

    get isOpen(): boolean {
      return open;
    },

    get path(): string | null {
      return currentPath;
    },

    forget(path: string): void {
      cache.delete(path);
    },
  };
}
