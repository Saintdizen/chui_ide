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
function harness(text: string, selection = '', budget?: () => { limit: number; overhead: number; reserve: number } | null) {
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
    ...(budget ? { attachmentBudget: budget } : {}),
  });
  const host = h('div');
  host.appendChild(view.element);
  return { session, view, chipNodes: () => host.querySelectorAll('.chip') };
}

describe('цена контекста видна до отправки', () => {
  it('у каждого чипа есть цена, и полоса подводит итог', () => {
    const { view, chipNodes } = harness('const x = 1;\n'.repeat(200), '', () => ({
      limit: 100_000,
      overhead: 1_000,
      reserve: 1_000,
    }));

    view.attachFrom('file');

    // Цена не только в подсказке (её надо навести), но и в самом чипе.
    expect(chipNodes()[0]!.textContent).toContain('т.');
    expect(view.element.textContent).toContain('Контекст:');
    expect(view.element.textContent).toContain('свободно');
  });

  it('не влезает — полоса говорит, сколько именно не уйдёт', () => {
    // Окно крошечное: приложенный файл не помещается целиком.
    const { view } = harness('const x = 1;\n'.repeat(400), '', () => ({
      limit: 400,
      overhead: 100,
      reserve: 100,
    }));

    view.attachFrom('file');

    const line = view.element.querySelector('.chip-budget')!;
    expect(line.classList.contains('is-over')).toBe(true);
    expect(line.textContent).toContain('не влезет');
  });

  it('бюджета нет — вес всё равно есть, обрезку не выдумываем', () => {
    const { view } = harness('const x = 1;\n'.repeat(50));

    view.attachFrom('file');

    const line = view.element.querySelector('.chip-budget')!;
    expect(line.textContent).toContain('Контекст:');
    expect(line.textContent).not.toContain('свободно');
    expect(line.textContent).not.toContain('влезет');
  });
});

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
