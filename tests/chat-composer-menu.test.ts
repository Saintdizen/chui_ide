import { beforeAll, describe, expect, it } from 'vitest';
import { createComposerMenu, type ContextKind } from '../src/renderer/ui/chat-composer-menu';
import type { ChatActionId } from '../src/shared/chat-actions';
import { h } from '../src/renderer/ui/dom';
import { installMiniDom } from './helpers/mini-dom';

beforeAll(() => {
  installMiniDom();
});

/**
 * Пункты `#` и `@` глазами человека.
 *
 * «Набрал `#` — вижу список» мало: важно, что выбранный пункт прикладывает
 * именно тот кусок и что набранный `#…`/`@…` не остаётся в вопросе.
 */
function harness(value: string, paths: readonly string[] = ['src/a.ts', 'src/b.ts', 'docs/zzz.md']) {
  const input = h('textarea') as unknown as HTMLTextAreaElement;
  input.value = value;
  const contexts: ContextKind[] = [];
  const mentions: string[] = [];
  const actions: ChatActionId[] = [];

  const view = createComposerMenu({
    input,
    onContext: (kind) => contexts.push(kind),
    onPickImage: () => undefined,
    onAttachBest: () => undefined,
    onMention: (path) => mentions.push(path),
    mentionPaths: () => paths,
    requestMentions: () => undefined,
    projectCommands: () => [],
    sessions: () => [],
    onMentionSession: () => undefined,
    requestCommands: () => undefined,
    onChatAction: (id) => actions.push(id),
  });

  const titles = (): string[] =>
    [...view.element.querySelectorAll('.composer-menu-item')].map((node) => node.textContent ?? '');

  return { input, view, contexts, mentions, actions, titles };
}

describe('`#` и `@` в композере', () => {
  it('`#sel` показывает только выделение', () => {
    const { view, titles } = harness('#sel');

    view.sync();

    expect(titles()).toHaveLength(1);
    expect(titles()[0]).toContain('#selection');
  });

  it('пункт `#` прикладывает контекст и убирает набранный `#…`', () => {
    const { input, view, contexts } = harness('объясни #sel');

    view.sync();
    (view.element.querySelectorAll('.composer-menu-item')[0] as unknown as { click(): void }).click();

    expect(contexts).toEqual(['selection']);
    // `#sel` был способом открыть список, а не частью вопроса: остаётся текст
    // и пробел под кареткой — продолжать писать можно сразу.
    expect(input.value).toBe('объясни ');
    // Выбранное закрывает список: пункт — это действие, а не набор.
    expect(view.element.hidden).toBe(true);
  });

  it('`@a` сужает список путей и не показывает чужие файлы', () => {
    const { view, titles } = harness('посмотри @a');

    view.sync();

    expect(titles().some((title) => title.includes('docs/zzz.md'))).toBe(false);
    expect(titles().some((title) => title.includes('src/a.ts'))).toBe(true);
  });

  it('выбранный путь уходит в приложенное, а `@…` исчезает из вопроса', () => {
    const { input, view, mentions, titles } = harness('посмотри @b');

    view.sync();
    const index = titles().findIndex((title) => title.includes('src/b.ts'));
    (view.element.querySelectorAll('.composer-menu-item')[index] as unknown as { click(): void }).click();

    expect(mentions).toEqual(['src/b.ts']);
    expect(input.value).toBe('посмотри ');
  });

  it('пустой список путей — меню закрыто, а не пустая рамка', () => {
    const { view, titles } = harness('@zzz', []);

    view.sync();

    expect(titles()).toHaveLength(0);
    expect(view.isOpen()).toBe(false);
  });
});
