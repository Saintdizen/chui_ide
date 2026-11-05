import { beforeAll, describe, expect, it } from 'vitest';
import type { ChatSession } from '../src/renderer/ui/chat-session';
import { createAttachments } from '../src/renderer/ui/chat-attachments';
import { h } from '../src/renderer/ui/dom';
import { installMiniDom } from './helpers/mini-dom';

beforeAll(() => {
  installMiniDom();
});

/**
 * Контекст `#` глазами человека: он выбирает пункт, а до отправки должен
 * видеть, что именно уедет модели, и уметь это снять.
 */
function harness(text: string, selection = '') {
  const session = { attachments: [], kept: [] } as unknown as ChatSession;
  const view = createAttachments({
    rpc: {} as never,
    documents: { get: () => ({ value: text }) } as never,
    editors: {
      currentPath: 'src/a.ts',
      selectedText: () => selection,
      markers: () => [],
    } as never,
    workspace: {} as never,
    composerText: () => '',
    session: () => session,
    focus: () => undefined,
  });
  const host = h('div');
  host.appendChild(view.element);
  return { session, view, chipNodes: () => host.querySelectorAll('.chip') };
}

describe('контекст `#` виден до отправки', () => {
  it('`#файл` ставит чип с именем файла', () => {
    const { session, view, chipNodes } = harness('const x = 1;\nconst y = 2;');

    view.attachFrom('file');

    expect(session.attachments).toHaveLength(1);
    expect(chipNodes()).toHaveLength(1);
    expect(chipNodes()[0]!.textContent).toContain('a.ts');
  });

  it('`#выделение` берёт выделение, а не файл целиком', () => {
    const { session, view } = harness('const x = 1;\nconst y = 2;', 'const y = 2;');

    view.attachFrom('selection');

    const text = session.attachments[0]!.text ?? '';
    expect(text).toContain('const y = 2;');
    expect(text).not.toContain('const x = 1;');
  });

  it('`#выделение` без выделения — честный отказ, а не файл целиком', () => {
    const { session, view } = harness('const x = 1;');

    view.attachFrom('selection');

    expect(session.attachments).toHaveLength(0);
  });

  it('тот же контекст дважды не удваивает чип', () => {
    const { session, view, chipNodes } = harness('const x = 1;');

    view.attachFrom('file');
    view.attachFrom('file');

    expect(session.attachments).toHaveLength(1);
    expect(chipNodes()).toHaveLength(1);
  });

  it('чип убирается, и приложенного больше нет', () => {
    const { session, view, chipNodes } = harness('const x = 1;');
    view.attachFrom('file');

    const chip = chipNodes()[0]! as unknown as HTMLElement;
    // Значки — SVG, кнопки — по классу: у «убрать» он свой, у «закрепить» — свой.
    (chip.querySelectorAll('.chip-remove')[0]! as unknown as HTMLElement).click();
    // Снятый чип сначала схлопывается, а снимается по концу анимации.
    (chip as unknown as { dispatchEvent(event: { type: string }): void }).dispatchEvent({ type: 'animationend' });

    expect(session.attachments).toHaveLength(0);
    expect(chipNodes()).toHaveLength(0);
    expect(view.element.hidden).toBe(true);
  });

  it('пустой файл не прикладывается: чип обещал бы текст, которого нет', () => {
    const { session, view } = harness('   \n  ');

    view.attachFrom('file');

    expect(session.attachments).toHaveLength(0);
  });
});
