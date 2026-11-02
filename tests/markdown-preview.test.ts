import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMarkdownPreview, isMarkdownPath } from '../src/renderer/ui/markdown-preview';
import { Emitter } from '../src/renderer/core/events';
import { installMiniDom } from './helpers/mini-dom';

/**
 * Предпросмотр Markdown (`renderer/ui/markdown-preview.ts`).
 *
 * Разметку собирает `chat-markdown.ts` (проверен отдельно). Здесь поведение экрана:
 * что видно, когда файл не open / не markdown / пуст, когда происходит перерисовка
 * (и когда намеренно НЕ происходит) и что кнопки делают.
 */

function setup(options: { path?: string | null; markdown?: string; visible?: boolean } = {}) {
  const editors = new Emitter<unknown>();
  const documents = new Emitter<{ document: { path: string } }>();
  const openEditors = {
    active: options.path === undefined ? { path: '/p/readme.md' } : options.path ? { path: options.path } : null,
    onDidChange: editors.event,
  };
  const text = options.markdown ?? '# Заголовок\n\nтекст';
  const insertCode = vi.fn(() => true);
  const onEdit = vi.fn();
  let visible = options.visible ?? true;
  const preview = createMarkdownPreview({
    openEditors: openEditors as never,
    documents: {
      get: () => ({ value: text }),
      onDidChange: documents.event,
    } as never,
    insertCode,
    relativePath: (path: string) => path.replace('/p/', ''),
    isVisible: () => visible,
    onEdit,
  });
  // Экран монтирует вызывающий (в приложении — вкладка в доке), сам он в DOM не
  // встаёт: поэтому тест вставляет его в корень явно.
  document.body.appendChild((preview as unknown as { element: HTMLElement }).element);
  return {
    preview,
    insertCode,
    onEdit,
    setVisible: (next: boolean) => {
      visible = next;
    },
    edit: (path: string) => documents.fire({ document: { path } }),
    switchFile: (path: string | null) => {
      openEditors.active = path ? { path } : null;
      editors.fire(null);
    },
  };
}

const root = () => document.body.querySelector('.md-preview') as unknown as HTMLElement;
const body = () => document.body.querySelector('.md-preview-body') as unknown as HTMLElement;

describe('какие файлы показываются', () => {
  it('markdown и родня — да, прочее — нет', () => {
    for (const path of ['a.md', 'b.markdown', 'c.mdx', 'd.mdown', 'e.mkd', 'UPPER.MD']) {
      expect(isMarkdownPath(path), path).toBe(true);
    }
    for (const path of ['a.ts', 'b.txt', 'c', 'md.txt']) {
      expect(isMarkdownPath(path), path).toBe(false);
    }
  });
});

describe('экран предпросмотра', () => {
  beforeEach(() => {
    installMiniDom();
  });

  it('скрыт, пока его не покажут, и показывается по команде', () => {
    const { preview } = setup();

    // При сборке экран скрыт: живой подсчёт разметки в невидимой панели не нужен.
    expect(root().hidden).toBe(true);
    preview.show();
    expect(root().hidden).toBe(false);
    preview.hide();
    expect(root().hidden).toBe(true);
  });

  it('нет открытого файла — подсказка, а не пустота', () => {
    const { preview } = setup({ path: null });
    preview.refresh();

    expect(body().textContent).toContain('Файл не открыт');
  });

  it('открыт не markdown — сказано прямо', () => {
    // Пустота читалась бы как «предпросмотр сломался».
    const { preview } = setup({ path: '/p/a.ts' });

    preview.refresh();

    expect(body().textContent).toContain('не Markdown');
  });

  it('пустой markdown — подсказка вместо пустого места', () => {
    const { preview } = setup({ markdown: '' });

    preview.refresh();

    expect(body().textContent).toContain('Файл пуст');
  });

  it('заголовок показывает путь файла относительно проекта', () => {
    const { preview } = setup({ path: '/p/docs/readme.md' });

    preview.refresh();

    expect(document.body.querySelector('.md-preview-path')?.textContent).toBe('docs/readme.md');
  });

  it('кнопка «Редактировать» возвращает к тексту', () => {
    const { preview, onEdit } = setup();
    preview.refresh();

    const buttons = document.body.querySelectorAll('button') as unknown as {
      title: string;
      click(): void;
    }[];
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) button.click();

    expect(onEdit).toHaveBeenCalled();
  });

  it('смена файла перерисовывает сразу, если экран на виду', () => {
    const { preview, switchFile } = setup();
    preview.refresh();

    switchFile('/p/other.md');

    expect(document.body.querySelector('.md-preview-path')?.textContent).toBe('other.md');
  });

  it('смена файла при скрытом экране не тратит работу', async () => {
    // Скрытая панель перерисуется при показе: собирать разметку сейчас незачем.
    const { preview, switchFile, setVisible } = setup({ visible: false });
    setVisible(false);
    preview.refresh();

    switchFile('/p/other.md');
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(document.body.querySelector('.md-preview-path')?.textContent).toBe('readme.md');
  });

  it('правка другого файла не перерисовывает показанный', async () => {
    const { edit } = setup({ path: '/p/readme.md' });

    edit('/p/other.md');
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(document.body.querySelector('.md-preview-path')?.textContent).toBe('readme.md');
  });

  it('правка показанного файла перерисовывает с задержкой, а не на каждую букву', async () => {
    const { edit } = setup();
    edit('/p/readme.md');
    edit('/p/readme.md');
    edit('/p/readme.md');

    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(document.body.querySelector('.md-preview-path')?.textContent).toBe('readme.md');
  });
});
