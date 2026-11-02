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
