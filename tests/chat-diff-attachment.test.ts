import { beforeAll, describe, expect, it, vi } from 'vitest';
import { installMiniDom } from './helpers/mini-dom';
import { createAttachments } from '../src/renderer/ui/chat-attachments';
import type { ChatAttachment } from '../src/shared/api';

const toasts = vi.hoisted(() => ({ list: [] as string[] }));
vi.mock('../src/renderer/ui/toast', () => ({
  showToast: (text: string) => toasts.list.push(text),
}));

/** Чипы — DOM: без мини-DOM виджет не создать. Устройство — как в остальных тестах вью. */
beforeAll(() => {
  installMiniDom();
});

/** Документов и редактора хватает пустых: `#diff` их не трогает. */
function make(git: unknown) {
  const session = { attachments: [] as ChatAttachment[] };
  const view = createAttachments({
    rpc: {} as never,
    documents: {} as never,
    editors: { selectedText: () => '', currentPath: null } as never,
    workspace: {} as never,
    git: git as never,
    composerText: () => '',
    session: () => session as never,
    focus: () => undefined,
  });
  return { view, session };
}

/** Как `make`, но с адресом открытой страницы браузера: `''` — ничего не открыто. */
function makeWeb(url: string) {
  const session = { attachments: [] as ChatAttachment[] };
  const view = createAttachments({
    rpc: {} as never,
    documents: {} as never,
    editors: { selectedText: () => '', currentPath: null } as never,
    workspace: {} as never,
    composerText: () => '',
    browserUrl: () => url,
    session: () => session as never,
    focus: () => undefined,
  });
  return { view, session };
}

/** Как `make`, но с местами по смыслу и набранным вопросом. */
function makeCodebase(
  codebase: (query: string) => Promise<readonly { path: string; line: number; text: string }[]>,
  typed: string,
) {
  const session = { attachments: [] as ChatAttachment[] };
  const view = createAttachments({
    rpc: {} as never,
    documents: {} as never,
    editors: { selectedText: () => '', currentPath: null } as never,
    workspace: {} as never,
    codebase,
    composerText: () => typed,
    session: () => session as never,
    focus: () => undefined,
  });
  return { view, session };
}

describe('#diff', () => {
  it('вкладка с изменениями: текст правок уходит контекстом', async () => {
    const git = {
      isRepository: true,
      staged: [],
      unstaged: [{ path: 'a.ts', staged: false }],
      diff: async () => ({
        original: 'a\nb',
        modified: 'a\nc',
        hunks: [{ oldStart: 1, oldCount: 2, newStart: 1, newCount: 2 }],
      }),
    };
    const { view, session } = make(git);
    view.attachFrom('diff');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.attachments).toHaveLength(1);
    expect(session.attachments[0]?.kind).toBe('diff');
    expect(session.attachments[0]?.text).toContain('-a');
    expect(session.attachments[0]?.text).toContain('+c');
  });

  it('не репозиторий: тост и ничего не приложено', async () => {
    toasts.list = [];
    const { view, session } = make({ isRepository: false });
    view.attachFrom('diff');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.attachments).toEqual([]);
    expect(toasts.list).toEqual(['Это не git-репозиторий']);
  });
});

describe('#web', () => {
  it('прикладывает адрес открытой страницы, а не её содержимое', () => {
    const { view, session } = makeWeb('https://example.com/doc');
    view.attachFrom('web');
    expect(session.attachments).toHaveLength(1);
    expect(session.attachments[0]?.kind).toBe('web');
    expect(session.attachments[0]?.text).toContain('https://example.com/doc');
  });

  it('страницы нет — говорит, что прикладывать нечего', () => {
    toasts.list = [];
    const { view, session } = makeWeb('');
    view.attachFrom('web');
    expect(session.attachments).toEqual([]);
    expect(toasts.list).toEqual(['В браузере не открыта страница']);
  });
});

describe('#codebase', () => {
  /** Как в остальных тестах вью: ждём микрозадачу — вложение собирается обещанием. */
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('вопрос из поля ввода уходит поиску, места — текстом с путями и строками', async () => {
    const asked: string[] = [];
    const { view, session } = makeCodebase(async (query) => {
      asked.push(query);
      return [
        { path: 'src/a.ts', line: 12, text: 'const shift = 2' },
        { path: 'src/b.ts', line: 3, text: 'openPalette()' },
      ];
    }, '  как открыть палитру  ');

    view.attachFrom('codebase');
    await flush();

    // Пробелы по краям — не часть вопроса: ищем по тексту как его написали.
    expect(asked).toEqual(['как открыть палитру']);
    expect(session.attachments).toHaveLength(1);
    const [attachment] = session.attachments;
    expect(attachment?.kind).toBe('codebase');
    expect(attachment?.title).toContain('как открыть палитру');
    expect(attachment?.text).toContain('src/a.ts:12: const shift = 2');
    expect(attachment?.text).toContain('src/b.ts:3: openPalette()');
  });

  it('пустое поле — ничего не ищется, человеку сказано что делать', async () => {
    toasts.list = [];
    let searched = 0;
    const { view, session } = makeCodebase(async () => {
      searched += 1;
      return [];
    }, '   ');

    view.attachFrom('codebase');
    await flush();

    expect(searched).toBe(0);
    expect(session.attachments).toEqual([]);
    expect(toasts.list).toEqual(['Напишите в поле ввода, что искать']);
  });

  it('ничего не нашлось — тост с самим запросом, вложений нет', async () => {
    toasts.list = [];
    const { view, session } = makeCodebase(async () => [], 'кентавр');

    view.attachFrom('codebase');
    await flush();

    expect(session.attachments).toEqual([]);
    expect(toasts.list).toEqual(['Ничего не нашлось по «кентавр»']);
  });

  it('поиск упал — тост с причиной, вложений нет', async () => {
    toasts.list = [];
    const { view, session } = makeCodebase(async () => {
      throw new Error('нет проекта');
    }, 'палитра');

    view.attachFrom('codebase');
    await flush();

    expect(session.attachments).toEqual([]);
    expect(toasts.list).toEqual(['Поиск не удался: нет проекта']);
  });
});
