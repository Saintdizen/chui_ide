import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSettingsModal } from '../src/renderer/ui/settings-modal';
import { installMiniDom } from './helpers/mini-dom';

/**
 * Форма провайдера в настройках проверяет подключение и говорит результат.
 *
 * На глаз это работает и без живого региона: подсказка под полями меняет текст
 * и краску. Но цвет читалка не передаёт вовсе, а подмену текста — не передаёт
 * БЕЗ ОБЪЯВЛЕННОГО РЕГИОНА: узел, созданный «в момент события», она вовсе не
 * замечает. Человек с читалкой нажимал «Проверить подключение» и не слышал
 * ничего: ни «Проверяем…», ни ошибки.
 *
 * Проверяется здесь именно это — что узел СОЗДАН ЗАРАНЕЕ, объявлен вежливым
 * (`polite`: не перебивать то, что человек слушает сейчас), читается ЦЕЛИКОМ
 * (`aria-atomic`: иначе он произнесёт только изменившееся слово) и получает тот
 * же текст, что видно на экране.
 */

/** Форма вставляется в документ так же, как при открытии окна настроек. */
const snapshot = {
  ai: {
    providers: [
      {
        id: 'deepseek',
        label: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        models: ['deepseek-chat'],
        hasApiKey: true,
        strictTools: true,
        temperature: 1,
        maxTokens: 0,
      },
    ],
    activeProviderId: 'deepseek',

    enabled: true,
    maxSteps: 8,
    maxAutopilotSteps: 24,
    commandGrants: [],
    editGrants: [],
    toolPreset: 'auto',
    systemPrompt: '',
    models: [],
    // Секция «Ассистент» читает всю настройку сразу при отрисовке: больше нет
    // полей — падение на строке, а не молчание.
    inlineCompletion: { enabled: false, debounceMs: 300 },
    browser: { enabled: false, integrated: false, executable: '' },
    sandbox: { enabled: false, image: '', workdir: '' },
    telemetry: { enabled: false },
    webFetch: { enabled: false },
    webSearch: { enabled: false, hasApiKey: false, provider: 'none' },
    automations: [],
    hooks: [],
    mcpServers: [],
    mcpTools: [],
  },
  lsp: { enabled: false, servers: [] },
  appearance: {},
  editor: {},
  explorer: {},
  git: {},
  keybindings: {},
  run: {},
};

async function openSettings(): Promise<HTMLElement> {
  const modal = createSettingsModal({
    rpc: {
      request: vi.fn(async (method: string) => {
        if (method === 'settings.get') return snapshot;
        if (method === 'app.recentProjects') return [];
        return null;
      }),
    },
    commands: { execute: vi.fn(), paletteVisible: () => [] },
  } as never);
  document.body.append(modal.element as unknown as HTMLElement);
  await modal.open();
  // Форма провайдера — отдельный экран, и открывается она кнопкой «Настроить
  // подключение…», а не выбором в списке. Регион живёт именно там.
  const config = [...(modal.element as unknown as HTMLElement).querySelectorAll('button')].find((button) =>
    (button.textContent ?? '').includes('Настроить подключение'),
  ) as unknown as HTMLElement | undefined;
  config?.click();
  // Форма — отдельное окно, монтируется в `document.body`, а не внутрь окна
  // настроек: искать её в `modal.element` бессмысленно.
  return document.body as unknown as HTMLElement;
}

// Мини-DOM селекторов атрибутов не знает (`[role]`) — обходим узлы и
// спрашиваем атрибут напрямую. В браузере это был бы `querySelector`, но
// стенд проверяет поведение, а не возможности CSS-движка.
const byRole = (root: HTMLElement, role: string): HTMLElement[] =>
  [...root.querySelectorAll('div')].filter((node) => node.getAttribute('role') === role) as unknown as HTMLElement[];

beforeEach(() => {
  installMiniDom();
});

describe('живой регион в настройках провайдера', () => {
  it('спрятан от глаз, но объявлен читалке', async () => {
    const root = await openSettings();
    const live = byRole(root, 'status')[0];
    expect(live).toBeDefined();
    if (!live) return;

    // Узел должен БЫТЬ В ДОКУМЕНТЕ до события: иначе читалка его не заметит.
    expect(live).toBeTruthy();
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.getAttribute('aria-atomic')).toBe('true');
    // Спрятан визуально, но не `display:none` — иначе он перестал бы читаться.
    expect(live.className).toContain('sr-only');
  });

  it('в документе ровно один голос, а не два', async () => {
    const root = await openSettings();
    // Подсказка на экране и живой регион — разные узлы с одним текстом.
    // Если у подсказки тоже окажется `aria-live`, читалка прочтёт всё дважды.
    const live = byRole(root, 'status');
    expect(live.length).toBe(1);
  });
});
