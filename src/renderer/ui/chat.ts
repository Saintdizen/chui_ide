import {
  ChatStreamEvent,
  type ChatDeltaPayload,
  type ChatMessage,
  type Settings,
} from '../../shared/api';
import type { CommandRegistry } from '../core/commands';
import type { DocumentStore } from '../core/document-store';
import type { EditorService } from '../core/editor-service';
import { RpcError, type RpcClient } from '../core/rpc';
import { clear, h, svgIcon } from './dom';
import { createSelect } from './select';
import { showToast } from './toast';

export interface ChatView {
  element: HTMLElement;
  newChat(): void;
  stop(): void;
  askAboutSelection(mode: 'explain' | 'fix'): Promise<void>;
  applySettings(settings: Settings): void;
}

export interface ChatDeps {
  rpc: RpcClient;
  documents: DocumentStore;
  editors: EditorService;
  commands: CommandRegistry;
  settings: Settings;
}

/**
 * Панель ассистента — правый «остров» в стиле tool window.
 *
 * Агентного цикла здесь пока нет: канал для него готов (`rpc.stream` +
 * `RpcClient.cancelActive`), а описания инструментов лежат в shared/tools.ts.
 */
export function createChatPanel(deps: ChatDeps): ChatView {
  let settings = deps.settings;
  const history: ChatMessage[] = [];
  let busy = false;
  let streamBuffer = '';
  let frame = 0;

  const providerSelect = createSelect({ title: 'Провайдер', placeholder: 'нет провайдера' });
  const modelInput = h('input', { class: 'field-input', type: 'text', list: 'chui-models', spellcheck: false });
  const modelList = h('datalist', { id: 'chui-models' });
  const apiKeyInput = h('input', { class: 'field-input', type: 'password', placeholder: 'API-ключ' });
  const keyState = h('div', { class: 'field-hint' });

  const config = h(
    'div',
    { class: 'chat-config', hidden: true },
    h('label', { class: 'field' }, h('span', {}, 'Провайдер'), providerSelect.element),
    h(
      'label',
      { class: 'field' },
      h('span', {}, 'Модель'),
      h(
        'div',
        { class: 'field-row' },
        modelInput,
        modelList,
        h(
          'button',
          { class: 'icon-btn', type: 'button', title: 'Загрузить список моделей', onClick: () => void loadModels() },
          svgIcon('refresh', 14),
        ),
      ),
    ),
    h(
      'label',
      { class: 'field' },
      h('span', {}, 'Ключ'),
      h(
        'div',
        { class: 'field-row' },
        apiKeyInput,
        h('button', { class: 'btn btn-small', type: 'button', onClick: () => void saveKey() }, 'Сохранить'),
      ),
    ),
    keyState,
    h('div', { class: 'field-hint' }, 'Ключ хранится в main-процессе и в renderer не попадает.'),
    h(
      'button',
      { class: 'link-btn', type: 'button', onClick: () => void deps.commands.execute('settings.open') },
      'Открыть settings.json',
    ),
  );

  const body = h('div', { class: 'chat-body' });
  const input = h('textarea', {
    class: 'chat-input',
    rows: 3,
    placeholder: 'Вопрос о коде… (Enter — отправить)',
    spellcheck: false,
  });
  const sendButton = h(
    'button',
    { class: 'btn btn-primary', type: 'button', onClick: () => void send(input.value) },
    svgIcon('send', 14),
    'Отправить',
  );
  const stopButton = h(
    'button',
    { class: 'btn', type: 'button', disabled: true, onClick: () => stop() },
    svgIcon('stop', 14),
    'Стоп',
  );

  const element = h(
    'div',
    { class: 'chat' },
    h(
      'div',
      { class: 'panel-header panel-header-ai' },
      svgIcon('sparkle', 15),
      h('span', { class: 'panel-title' }, 'AI Assistant'),
      h(
        'div',
        { class: 'panel-actions' },
        h(
          'button',
          {
            class: 'icon-btn',
            type: 'button',
            title: 'Провайдер, модель, ключ',
            onClick: () => {
              config.hidden = !config.hidden;
            },
          },
          svgIcon('settings', 15),
        ),
        h('button', { class: 'icon-btn', type: 'button', title: 'Новый диалог', onClick: () => newChat() }, svgIcon('chat', 15)),
      ),
    ),
    config,
    body,
    h(
      'div',
      { class: 'chat-footer' },
      input,
      h(
        'div',
        { class: 'chat-actions' },
        h('span', { class: 'chat-hint' }, 'Alt+F12 — терминал'),
        stopButton,
        sendButton,
      ),
    ),
  );

  /* ── провайдеры и ключ ─────────────────────────────────────────────────── */

  function currentProvider() {
    return settings.ai.providers.find((provider) => provider.id === providerSelect.value) ?? settings.ai.providers[0];
  }

  function renderProviders(): void {
    const previous = providerSelect.value;

    providerSelect.setOptions(settings.ai.providers.map((provider) => ({ value: provider.id, label: provider.label })));

    const fallback = settings.ai.activeProviderId ?? settings.ai.providers[0]?.id ?? '';
    const known = settings.ai.providers.some((provider) => provider.id === previous);
    providerSelect.setValue(known ? previous : fallback);
    syncProviderFields();
  }

  function syncProviderFields(): void {
    const provider = currentProvider();
    if (!provider) return;

    modelInput.value =
      settings.ai.activeProviderId === provider.id && settings.ai.activeModel
        ? settings.ai.activeModel
        : (provider.defaultModel ?? provider.models[0] ?? '');

    clear(modelList);
    for (const model of provider.models) modelList.appendChild(h('option', { value: model }));

    keyState.textContent = provider.hasApiKey
      ? `Ключ для «${provider.label}» сохранён`
      : `Ключ для «${provider.label}» не задан · ${provider.baseUrl}`;
  }

  async function loadModels(): Promise<void> {
    const provider = currentProvider();
    if (!provider) return;
    try {
      const models = await deps.rpc.request('ai.models', { providerId: provider.id });
      clear(modelList);
      for (const model of models) modelList.appendChild(h('option', { value: model }));
      if (!modelInput.value && models[0]) modelInput.value = models[0];
      showToast(`«${provider.label}»: доступно моделей — ${models.length}`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  async function saveKey(): Promise<void> {
    const provider = currentProvider();
    if (!provider) return;
    const apiKey = apiKeyInput.value.trim();
    try {
      settings = apiKey
        ? await deps.rpc.request('ai.setApiKey', { providerId: provider.id, apiKey })
        : await deps.rpc.request('ai.clearApiKey', { providerId: provider.id });
      apiKeyInput.value = '';
      syncProviderFields();
      showToast(apiKey ? 'Ключ сохранён' : 'Ключ удалён');
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  providerSelect.onChange(() => syncProviderFields());

  /* ── рендер сообщений ──────────────────────────────────────────────────── */

  function scrollToEnd(): void {
    body.scrollTop = body.scrollHeight;
  }

  function appendMessage(role: 'user' | 'assistant', text: string): HTMLElement {
    const content = h('div', { class: 'msg-body' });
    if (text) renderInto(content, text);
    body.appendChild(h('div', { class: `msg msg-${role}` }, content));
    scrollToEnd();
    return content;
  }

  function scheduleRender(target: HTMLElement): void {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      renderInto(target, streamBuffer);
      scrollToEnd();
    });
  }

  function cancelFrame(): void {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  }

  function renderIntro(): void {
    clear(body);
    body.appendChild(
      h(
        'div',
        { class: 'chat-intro' },
        h('p', {}, 'Ассистент видит рабочую папку и файл, открытый в редакторе.'),
        h(
          'p',
          { class: 'field-hint' },
          'Выделите код и выберите AI → «Объяснить выделение»: фрагмент уйдёт вместе с запросом.',
        ),
      ),
    );
  }

  /* ── отправка ──────────────────────────────────────────────────────────── */

  async function send(raw: string): Promise<void> {
    const text = raw.trim();
    if (!text || busy) return;

    const provider = currentProvider();
    if (!provider) {
      showToast('Провайдер не настроен', 'error');
      return;
    }

    const model = modelInput.value.trim() || provider.defaultModel || provider.models[0] || '';
    if (!model) {
      showToast('Укажите модель в настройках провайдера', 'error');
      return;
    }

    input.value = '';
    history.push({ role: 'user', content: text });
    appendMessage('user', text);

    const assistantContent = appendMessage('assistant', '');
    const thinking = h('span', { class: 'typing' }, 'думает…');
    assistantContent.appendChild(thinking);

    streamBuffer = '';
    setBusy(true);

    const complete = (finalText: string, note?: string): void => {
      cancelFrame();
      renderInto(assistantContent, finalText);
      if (note) assistantContent.appendChild(h('div', { class: 'field-hint' }, note));
      history.push({ role: 'assistant', content: finalText });
      scrollToEnd();
    };

    try {
      const done = await deps.rpc.stream(
        'ai.chat',
        { providerId: provider.id, model, messages: history.map((message) => ({ ...message })) },
        (event, payload) => {
          if (event !== ChatStreamEvent.Delta) return;
          thinking.remove();
          streamBuffer += (payload as ChatDeltaPayload).text;
          scheduleRender(assistantContent);
        },
      );

      const usage = done.usage;
      complete(done.text, usage ? `токены: ${usage.promptTokens ?? '?'} → ${usage.completionTokens ?? '?'}` : undefined);
    } catch (error) {
      thinking.remove();
      if (error instanceof RpcError && error.cancelled) {
        complete(streamBuffer, 'генерация остановлена');
      } else {
        clear(assistantContent);
        assistantContent.appendChild(h('p', { class: 'msg-error' }, error instanceof Error ? error.message : String(error)));
        showToast('Не удалось получить ответ модели', 'error');
      }
    } finally {
      setBusy(false);
      void deps.rpc
        .request('settings.update', { ai: { activeProviderId: provider.id, activeModel: model } })
        .catch(() => undefined);
    }
  }

  function setBusy(value: boolean): void {
    busy = value;
    sendButton.disabled = value;
    stopButton.disabled = !value;
    input.disabled = value;
  }

  function stop(): void {
    if (!busy) {
      showToast('Сейчас ничего не генерируется');
      return;
    }
    deps.rpc.cancelActive();
  }

  function newChat(): void {
    if (busy) deps.rpc.cancelActive();
    history.length = 0;
    streamBuffer = '';
    renderIntro();
    input.focus();
  }

  async function askAboutSelection(mode: 'explain' | 'fix'): Promise<void> {
    const selection = deps.editors.selectedText();
    if (!selection.trim()) {
      showToast('Сначала выделите фрагмент кода в редакторе', 'error');
      return;
    }

    const path = deps.editors.currentPath;
    const language = path ? (deps.documents.get(path)?.languageId ?? '') : '';
    const where = path ? ` из файла ${path}` : '';
    const prompt =
      mode === 'explain'
        ? `Объясни этот код${where}:\n\n\`\`\`${language}\n${selection}\n\`\`\``
        : `Найди ошибки в этом коде${where} и предложи исправление. Ответь минимальным диффом:\n\n\`\`\`${language}\n${selection}\n\`\`\``;

    await send(prompt);
  }

  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    void send(input.value);
  });

  renderProviders();
  renderIntro();

  return {
    element,
    newChat,
    stop,
    askAboutSelection,
    applySettings(next: Settings) {
      settings = next;
      renderProviders();
    },
  };
}

/**
 * Очень скромный рендер markdown: блоки кода в ``` и обычный текст.
 * Никакого innerHTML — узлы создаются напрямую, поэтому ответ модели
 * не может вставить разметку в интерфейс.
 */
function renderInto(container: HTMLElement, text: string): void {
  clear(container);
  if (!text) return;

  text.split('```').forEach((part, index) => {
    if (index % 2 === 1) {
      const newline = part.indexOf('\n');
      const code = newline >= 0 ? part.slice(newline + 1) : part;
      container.appendChild(h('pre', { class: 'code-block' }, h('code', {}, code.replace(/\n$/, ''))));
      return;
    }
    const trimmed = part.trim();
    if (trimmed) container.appendChild(h('p', { class: 'text-block' }, trimmed));
  });
}
