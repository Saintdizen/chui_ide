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

/**
 * `#` в композере — один вход и для команд контекста, и для путей проекта.
 * Разделить их нечем: `#sel` и `#src/app.ts` — одинаковый набор символов.
 * Команды идут первыми (их конечный список), пути — по вхождению: помнят
 * «app.ts», а не «src/main/app.ts».
 */
describe('пути в `#`-подсказке', () => {
  const PATHS = ['src/main/app.ts', 'src/renderer/app.ts', 'docs/readme.md'];

  it('набранный `#` показывает команды контекста и пути проекта', () => {
    const { view, titles } = harness('#', PATHS);
    view.sync();
    const all = titles();
    expect(all.some((title) => title.startsWith('#sel'))).toBe(true);
    expect(all.some((title) => title.includes('#src/main/app.ts'))).toBe(true);
  });

  it('буквы после `#` сужают и то и другое', () => {
    const { view, titles } = harness('#app', PATHS);
    view.sync();
    const all = titles();
    expect(all.every((title) => title.toLowerCase().includes('app') || title.startsWith('#'))).toBe(true);
    expect(all.some((title) => title.includes('#src/main/app.ts'))).toBe(true);
    expect(all.some((title) => title.includes('readme.md'))).toBe(false);
  });

  it('слэш в набранном сужает по началу пути, а не по вхождению', () => {
    // `#src/main` — человек идёт по папкам: `docs/src/main` не должен лезть.
    const { view, titles } = harness('#src/main', ['src/main/app.ts', 'docs/src/main/x.ts']);
    view.sync();
    const all = titles();
    expect(all.some((title) => title.includes('#src/main/app.ts'))).toBe(true);
    expect(all.some((title) => title.includes('docs/src/main/x.ts'))).toBe(false);
  });

  it('выбор пути прикладывает его и вычищает `#` из ввода', () => {
    const { view, input, mentions, titles } = harness('смотри #app', PATHS);
    view.sync();
    const index = titles().findIndex((title) => title.includes('#src/main/app.ts'));
    view.moveCursor(index + 1);
    (view.element.querySelectorAll('.composer-menu-item')[index] as HTMLElement).click();
    expect(mentions).toEqual(['src/main/app.ts']);
    // Пробел перед `#` остаётся и становится хвостом: набранный маркер вырезан,
    // текст вокруг не переписывается.
    expect(input.value.trimEnd()).toBe('смотри');
  });

  it('пустой список путей просит их собрать', () => {
    const collected: number[] = [];
    const view = createComposerMenu({
      input: Object.assign(h('textarea') as unknown as HTMLTextAreaElement, { value: '#app' }),
      onContext: () => undefined,
      onPickImage: () => undefined,
      onAttachBest: () => undefined,
      onMention: () => undefined,
      mentionPaths: () => [],
      requestMentions: () => collected.push(1),
      projectCommands: () => [],
      sessions: () => [],
      onMentionSession: () => undefined,
      requestCommands: () => undefined,
      onChatAction: () => undefined,
    });
    view.sync();
    expect(collected).toHaveLength(1);
  });
});
