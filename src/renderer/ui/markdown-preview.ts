import type { DocumentStore } from '../core/document-store';
import type { OpenEditors } from '../core/open-editors';
import { createMarkdownRenderer } from './chat-markdown';
import { clear, h, svgIcon } from './dom';

/**
 * Предпросмотр Markdown: разметка открытого файла, как её прочитает читатель.
 *
 * Это режим вкладки, а не отдельная панель: файл .md показывается либо текстом, либо
 * разметкой, и переключает их кнопка в самой вкладке (как «Открыть предпросмотр»).
 * Экран ложится поверх области редактора — тем же приёмом, что вьюер картинок и
 * встроенный браузер. Рисует его тот же разборщик, что ленту чата (`chat-markdown.ts`):
 * он собирает узлы напрямую, без `innerHTML`, поэтому чужой markdown не вставит
 * разметку в интерфейс.
 *
 * Текст берётся из документа (с несохранёнными правками). Перерисовка идёт по правке с
 * небольшой задержкой и только когда экран на виду: пересобирать разметку на каждое
 * нажатие незачем. Когда показан не markdown — говорим об этом, а не показываем пустоту:
 * пустота читалась бы как «сломалось».
 */

export interface MarkdownPreviewDeps {
  openEditors: OpenEditors;
  documents: DocumentStore;
  /** Вставить код из блока в позицию курсора (кнопка «Вставить»). */
  insertCode(code: string): boolean;
  /** Короткий путь для заголовка. */
  relativePath(path: string): string;
  /** Экран сейчас на виду — обновлять скрытый смысла нет. */
  isVisible(): boolean;
  /** Вернуться к правке текста (кнопка в шапке предпросмотра). */
  onEdit(): void;
}

export interface MarkdownPreviewView {
  element: HTMLElement;
  /** Показать разметку активного файла. */
  show(): void;
  hide(): void;
  /** Перерисовать по активному файлу. */
  refresh(): void;
}

/** Пауза перед перерисовкой: разметку смотрим не на каждое нажатие. */
const REFRESH_DELAY = 250;

/** Файл, который умеет показывать предпросмотр: markdown и его родня. */
export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx|mdown|mkd)$/i.test(path);
}

export function createMarkdownPreview(deps: MarkdownPreviewDeps): MarkdownPreviewView {
  const renderer = createMarkdownRenderer({ insertCode: (code) => deps.insertCode(code) });

  const title = h('span', { class: 'md-preview-title' }, 'Предпросмотр');
  const pathLabel = h('span', { class: 'md-preview-path' });
  // Кнопка возврата к тексту: тот же переключатель, что в вкладке, — чтобы не
  // искать его в полосе, когда взгляд на разметке.
  const editButton = h(
    'button',
    { class: 'btn btn-small', type: 'button', title: 'Показать исходный текст', onClick: () => deps.onEdit() },
    svgIcon('pencil', 13),
    h('span', {}, 'Редактировать'),
  );
  const head = h(
    'div',
    { class: 'md-preview-head' },
    title,
    pathLabel,
    h('div', { class: 'md-preview-spacer' }),
    editButton,
  );
  const body = h('div', { class: 'md-preview-body' });
  const element = h('div', { class: 'md-preview', hidden: true }, head, body);

  let timer: number | null = null;

  const note = (text: string): void => {
    clear(body);
    body.appendChild(h('div', { class: 'empty-note' }, h('p', {}, text)));
  };

  const render = (): void => {
    const path = deps.openEditors.active?.path ?? null;
    if (!path) {
      pathLabel.textContent = '';
      note('Файл не открыт: предпросмотр показывает активный файл Markdown.');
      return;
    }
    pathLabel.textContent = deps.relativePath(path);
    if (!isMarkdownPath(path)) {
      note('Активный файл — не Markdown. Откройте файл .md, чтобы увидеть разметку.');
      return;
    }
    const text = deps.documents.get(path)?.value ?? '';
    renderer.renderInto(body, text);
    // Пустой файл начнут печатать — а пока подсказка вместо пустоты.
    if (body.textContent === '') note('Файл пуст — начните печатать, и разметка появится тут.');
  };

  const refresh = (): void => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    render();
  };

  // Смена активного файла — другой markdown: панель на виду, значит обновляем сразу.
  deps.openEditors.onDidChange(() => {
    if (deps.isVisible()) refresh();
    else if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  });
  // Правка текста: перерисовка с задержкой и только для показанного файла.
  deps.documents.onDidChange(({ document }) => {
    if (!deps.isVisible() || document.path !== deps.openEditors.active?.path) return;
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      render();
    }, REFRESH_DELAY);
  });

  refresh();

  return {
    element,
    refresh,
    show(): void {
      element.hidden = false;
      refresh();
    },
    hide(): void {
      element.hidden = true;
    },
  };
}
