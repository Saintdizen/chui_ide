import { beforeAll, describe, expect, it } from 'vitest';
import type { ChatSession } from '../src/renderer/ui/chat-session';
import type { FileEdit } from '../src/shared/edits';
import { createAskPrompt, createEditReview, type ApprovalHost } from '../src/renderer/ui/chat-approvals';
import { installMiniDom } from './helpers/mini-dom';

beforeAll(() => {
  installMiniDom();
});

function session(id: number): ChatSession {
  return { id, uid: `uid-${id}` } as unknown as ChatSession;
}

/**
 * Заглушка окна решений: запоминает, в чью ленту легла карточка, и сразу
 * отвечает так, будто человек нажал кнопку.
 */
function harness(answer: { file?: boolean; asked?: string } = {}) {
  const mounted: { block: HTMLElement; session?: ChatSession }[] = [];
  const host: ApprovalHost = {
    readText: () => 'a\nb\n',
    mount: (block: HTMLElement, target?: ChatSession) => {
      mounted.push({ block, session: target });
    },
    returnFocus: () => undefined,
    scrollToEnd: () => undefined,
    rememberFileGrant: () => undefined,
    rememberCommandGrant: () => undefined,
    register: () => () => undefined,
  } as unknown as ApprovalHost;
  return { host, mounted, answer };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('карточка решения знает свою беседу', () => {
  it('правки: карточка едет вместе с беседой, которая спросила', async () => {
    const { host, mounted } = harness();
    const review = createEditReview(host);
    const target = session(7);
    const edits: FileEdit[] = [
      { path: 'a.ts', edits: [{ startLine: 1, startColumn: 1, endLine: 1, endColumn: 2, newText: 'a' }] },
    ];

    const pending = review.review(edits, target);
    await tick();
    const card = mounted[0]!.block;
    (card.querySelector('.btn-primary') as HTMLElement).click();
    await pending;

    expect(mounted).toHaveLength(1);
    expect(mounted[0]!.session).toBe(target);
  });

  it('вопрос модели: тот же адрес', async () => {
    const { host, mounted } = harness();
    const ask = createAskPrompt(host);
    const target = session(3);

    const pending = ask.ask('Как назвать файл?', ['a', 'b'], target);
    await tick();
    const card = mounted[0]!.block;
    (card.querySelector('input') as HTMLInputElement).value = 'a';
    (card.querySelector('.btn-primary') as HTMLElement).click();
    await pending;

    expect(mounted[0]!.session).toBe(target);
  });

  it('без беседы адрес пуст — панель возьмёт открытую', async () => {
    const { host, mounted } = harness();
    const review = createEditReview(host);
    const edits: FileEdit[] = [
      { path: 'a.ts', edits: [{ startLine: 1, startColumn: 1, endLine: 1, endColumn: 2, newText: 'a' }] },
    ];

    const pending = review.review(edits);
    await tick();
    const card = mounted[0]!.block;
    (card.querySelector('.btn-primary') as HTMLElement).click();
    await pending;

    // Карточка есть, но адреса нет: решать, куда её положить, будет панель.
    expect(mounted).toHaveLength(1);
    expect(mounted[0]!.session).toBeUndefined();
  });
});
