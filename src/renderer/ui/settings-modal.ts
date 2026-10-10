import type {
  EditorSettings,
  ExplorerSettings,
  LspServerConfig,
  ReasoningEffort,
  RecentProject,
  RunSettings,
  Settings,
  SettingsPatch,
  ThemeChoice,
} from '../../shared/api';
import type { AiProviderPatch, McpServerTools } from '../../shared/api';
import type { McpServerConfig } from '../../shared/mcp';
import { PROVIDER_PRESETS, findProviderPreset } from '../../shared/providers';
import type { WebSearchProvider } from '../../shared/web-search';
import { lspLanguagesForKind } from '../../shared/lsp-presets';
import type { CommandRegistry } from '../core/commands';
import type { RpcClient } from '../core/rpc';
import type { ThemeService } from '../core/theme-service';
import { type Child, append, clear, h, svgIcon } from './dom';
import { createSelect } from './select';
import { showToast } from './toast';

export interface SettingsModalDeps {
  rpc: RpcClient;
  commands: CommandRegistry;
  theme: ThemeService;
  /**
   * Проектные настройки из `.chui_ide`: `kind` — вид проекта для фильтрации
   * секций, `patch` — сохранить правку проектных секций (editor/explorer/run/lsp).
   */
  project?: {
    kind: () => string | null;
    patch: (value: SettingsPatch) => Promise<Settings>;
  };
}

export interface SettingsModalView {
  /** Слой модального окна: живёт в body, чтобы не обрезаться панелями. */
  element: HTMLElement;
  /** Перечитать настройки и показать окно. */
  open(): Promise<void>;
  close(): void;
  /** Текущее состояние из main (push `settings:changed`). */
  applySettings(settings: Settings): void;
}

type SectionId = 'ai' | 'editor' | 'explorer' | 'run' | 'appearance' | 'project' | 'lsp' | 'mcp';

const SECTIONS: ReadonlyArray<{
  id: SectionId;
  title: string;
  icon: 'sparkle' | 'file' | 'sun' | 'panel' | 'folder' | 'play' | 'command';
}> = [
  { id: 'ai', title: 'AI', icon: 'sparkle' },
  { id: 'editor', title: 'Редактор', icon: 'file' },
  { id: 'explorer', title: 'Проводник', icon: 'folder' },
  { id: 'run', title: 'Запуск', icon: 'play' },
  { id: 'appearance', title: 'Внешний вид', icon: 'sun' },
  { id: 'lsp', title: 'Языки (LSP)', icon: 'command' },
  { id: 'mcp', title: 'Внешние инструменты (MCP)', icon: 'sparkle' },
  { id: 'project', title: 'Проект', icon: 'panel' },
];

const THEME_OPTIONS: ReadonlyArray<{ value: ThemeChoice; label: string }> = [
  { value: 'system', label: 'Как в системе' },
  { value: 'dark', label: 'Тёмная' },
  { value: 'light', label: 'Светлая' },
];

/**
 * Модальное окно настроек приложения.
 *
 * Все настройки в одном месте: AI, редактор, внешний вид и проект. Значения
 * уходят в main через `settings.update`, а обратно приходит уже нормализованное
 * состояние — renderer не хранит собственную копию правды.
 */
export function createSettingsModal(deps: SettingsModalDeps): SettingsModalView {
  let settings: Settings | null = null;
  let section: SectionId = 'ai';
  /** Строка поиска по настройкам: пустая — обычный вид с разделом. */
  let query = '';
  let recent: RecentProject[] = [];
  /** Итог последней проверки подключения: показываем прямо в панели. */
  let testResult: { ok: boolean; message: string } | null = null;
  /** Модели, которые отдал провайдер при проверке. */
  let testedModels: string[] = [];
  /**
   * Языки, у которых сервер поднят сейчас. `null` — ещё не спрашивали: показываем
   * это состояние, чтобы не обещать «ничего не запущено» до ответа main.
   */
  let lspRunning: string[] | null = null;
  /** Итог проверки серверов MCP: что ответил каждый и что не поднялось. */
  let mcpStatus: string | null = null;

  // Поиск по настройкам: подписи полей всех разделов сразу, а не обход разделов
  // по одному. Живёт над списком разделов и не уезжает при его прокрутке.
  const search = h('input', {
    class: 'modal-search',
    type: 'search',
    placeholder: 'Поиск настроек',
    spellcheck: false,
    'aria-label': 'Поиск настроек',
  });
  search.addEventListener('input', () => {
    query = search.value;
    render();
  });

  const nav = h('nav', { class: 'modal-nav' });
  const pane = h('div', { class: 'modal-pane' });
  const title = h('span', { class: 'modal-title' }, 'Настройки');

  const closeButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Закрыть (Esc)', onClick: () => close() },
    svgIcon('close', 15),
  );

  const element = h(
    'div',
    { class: 'modal-backdrop', hidden: true },
    h(
      'div',
      { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Настройки приложения' },
      h('header', { class: 'modal-header' }, svgIcon('settings', 15), title, closeButton),
      h('div', { class: 'modal-body' }, h('div', { class: 'modal-nav-column' }, search, nav), pane),
      h(
        'footer',
        { class: 'modal-footer' },
        h(
          'button',
          {
            class: 'link-btn',
            type: 'button',
            onClick: () => {
              close();
              void deps.commands.execute('settings.revealFile');
            },
          },
          'Открыть settings.json',
        ),
        h('button', { class: 'btn btn-primary', type: 'button', onClick: () => close() }, 'Готово'),
      ),
    ),
  );

  /* ── инфраструктура окна ───────────────────────────────────────────────── */

  const isOpen = (): boolean => !element.hidden;

  function close(): void {
    if (!isOpen()) return;
    element.hidden = true;
    document.removeEventListener('keydown', onKeyDown, true);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    // Esc в поиске сначала снимает запрос: закрывать окно, теряя набранное,
    // человек не просил. Поиск пуст — закрываем, как раньше.
    if (query) {
      query = '';
      search.value = '';
      render();
      return;
    }
    close();
  }

  // Клик по затемнению закрывает окно, клик по самому окну — нет.
  element.addEventListener('pointerdown', (event) => {
    if (event.target === element) close();
  });

  async function open(): Promise<void> {
    element.hidden = false;
    // Слушаем в capture и позже текущего клика, иначе Esc сработает на открытии.
    document.removeEventListener('keydown', onKeyDown, true);
    window.setTimeout(() => document.addEventListener('keydown', onKeyDown, true), 0);

    try {
      settings = await deps.rpc.request('settings.get');
      recent = await deps.rpc.request('app.recentProjects');
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
    // Статус серверов спрашиваем заново при каждом открытии окна: он меняется.
    lspRunning = null;
    // Окно открывается в известном виде: прошлый поиск тут только запутал бы.
    query = '';
    search.value = '';
    render();
  }

  /** Спросить у main, какие языковые серверы подняты, и перерисовать панель. */
  async function refreshLspStatus(): Promise<void> {
    lspRunning = await deps.rpc
      .request('lsp.status')
      .then((status) => status.running)
      .catch(() => []);
    render();
  }

  function applySettings(next: Settings): void {
    settings = next;
    // Намеренно без перерисовки: push приходит на каждое сохранённое значение,
    // и перестройка панели выбивала бы фокус из поля, которое только что правили.
  }

  /** Отправить патч и запомнить нормализованный ответ main. */
  async function patch(value: SettingsPatch, rerender = false): Promise<void> {
    try {
      settings = deps.project ? await deps.project.patch(value) : await deps.rpc.request('settings.update', value);
      if (rerender) render();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  /* ── сборка полей ──────────────────────────────────────────────────────── */

  // Поля — именно `div`, а не `label`: внутри лежат составные контролы
  // (выпадающий список — это кнопка), и клик по «подписи» нажимал бы их дважды.
  function field(label: string, ...controls: Child[]): HTMLElement {
    return h('div', { class: 'field' }, h('span', {}, label), ...controls);
  }

  function textInput(value: string, onCommit: (next: string) => void): HTMLInputElement {
    const input = h('input', { class: 'field-input', type: 'text', spellcheck: false });
    input.value = value;
    input.addEventListener('change', () => onCommit(input.value.trim()));
    return input;
  }

  function numberInput(
    value: number,
    min: number,
    max: number,
    step: number,
    onCommit: (next: number) => void,
  ): HTMLInputElement {
    const input = h('input', { class: 'field-input', type: 'number', min, max, step });
    input.value = String(value);
    input.addEventListener('change', () => {
      const next = Number(input.value);
      if (!Number.isFinite(next)) {
        input.value = String(value);
        return;
      }
      onCommit(Math.min(Math.max(next, min), max));
    });
    return input;
  }

  function switchRow(label: string, checked: boolean, onChange: (next: boolean) => void): HTMLElement {
    const input = h('input', { class: 'switch-input', type: 'checkbox' });
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    return h(
      'div',
      { class: 'field field-between' },
      h('span', {}, label),
      h('label', { class: 'switch' }, input, h('span', { class: 'switch-track' })),
    );
  }

  /** Селект приложения: системный `<select>` не подчиняется ни палитре, ни плотности. */
  function selectInput(
    options: ReadonlyArray<{ value: string; label: string }>,
    value: string,
    onChange: (next: string) => void,
  ): HTMLElement {
    const select = createSelect({});
    select.setOptions(options);
    select.setValue(value);
    select.onChange(onChange);
    return select.element;
  }

  /**
   * Итог проверки серверов MCP человеческим текстом: по серверу в строке. Имена
   * инструментов показываем целиком — по ним видно, что сервер даёт агенту.
   */
  function describeMcpStatus(list: McpServerTools[]): string {
    if (list.length === 0) return 'Серверы не заданы — агент работает только своими инструментами.';
    return list
      .map((server) => {
        if (server.error) return `${server.id}: ${server.error}`;
        if (server.tools.length === 0) return `${server.id}: инструментов не объявлено`;
        const names = server.tools
          .map((tool) => `${tool.name}${tool.readOnly ? '' : ' (спросит подтверждение)'}`)
          .join(', ');
        return `${server.id}: инструментов ${server.tools.length} — ${names}`;
      })
      .join('\n');
  }

  /* ── секции ────────────────────────────────────────────────────────────── */

  function renderAi(): Child[] {
    const ai = settings!.ai;
    const provider = ai.providers.find((item) => item.id === ai.activeProviderId) ?? ai.providers[0];
    const preset = provider ? findProviderPreset(provider.id) : undefined;

    const providerSelect = createSelect({ title: 'Активный провайдер', placeholder: 'нет провайдера' });
    providerSelect.setOptions(ai.providers.map((item) => ({ value: item.id, label: item.label })));
    providerSelect.setValue(provider?.id ?? '');
    providerSelect.onChange((value) => {
      testedModels = [];
      testResult = null;
      void patch({ ai: { activeProviderId: value } }, true);
    });

    // Добавление: пресет сам подставляет адрес и стартовые модели.
    const available = PROVIDER_PRESETS.filter(
      (item) => item.id === 'custom' || !ai.providers.some((existing) => existing.id === item.id),
    );
    let presetId = available[0]?.id ?? 'custom';
    const presetSelect = createSelect({ title: 'Готовые провайдеры' });
    presetSelect.setOptions(available.map((item) => ({ value: item.id, label: item.label })));
    presetSelect.setValue(presetId);
    presetSelect.setDisabled(available.length === 0);
    presetSelect.onChange((value) => {
      presetId = value;
    });

    const addButton = h(
      'button',
      { class: 'btn btn-small', type: 'button', onClick: () => void addProvider(presetId) },
      'Добавить',
    );
    const removeButton = h(
      'button',
      {
        class: 'btn btn-small',
        type: 'button',
        disabled: ai.providers.length <= 1,
        onClick: () => void removeProvider(provider?.id ?? ''),
      },
      'Удалить',
    );

    const labelInput = textInput(provider?.label ?? '', (value) => {
      if (provider && value) void patchProvider({ id: provider.id, label: value });
    });
    if (preset && preset.id !== 'custom') labelInput.placeholder = preset.label;

    const baseUrlInput = textInput(provider?.baseUrl ?? '', (value) => {
      if (provider && value) void patchProvider({ id: provider.id, baseUrl: value });
    });
    if (preset) baseUrlInput.placeholder = preset.baseUrl;

    const keyInput = h('input', {
      class: 'field-input',
      type: 'password',
      placeholder: preset?.needsKey === false ? 'Ключ не нужен' : 'Вставьте API-ключ',
    });
    const testButton = h(
      'button',
      { class: 'btn btn-small', type: 'button', onClick: () => void runTest() },
      'Проверить подключение',
    );
    // Ключ можно не только заменить, но и убрать: иначе сохранённый ключ не стереть,
    // а он мешает, когда переходишь на переменную окружения или меняешь провайдера.
    const clearKeyButton = h(
      'button',
      { class: 'btn btn-small', type: 'button', onClick: () => void clearKey() },
      'Убрать ключ',
    );

    const statusText = testResult
      ? testResult.message
      : provider?.hasApiKey
        ? 'Ключ сохранён'
        : preset?.needsKey === false
          ? 'Локальный сервер — ключ не нужен'
          : 'Ключ не задан';
    const status = h(
      'div',
      { class: `field-hint${testResult ? (testResult.ok ? ' is-ok' : ' is-error') : ''}` },
      statusText,
    );

    // Модель выбирается из списка, а не вводится руками: меньше опечаток.
    const models = [...new Set([...(provider?.models ?? []), ...testedModels])];
    const currentModel = ai.activeModel ?? provider?.defaultModel ?? models[0] ?? '';
    const modelOptions = models.map((model) => ({ value: model, label: model }));
    if (currentModel && !models.includes(currentModel))
      modelOptions.unshift({ value: currentModel, label: currentModel });

    const modelField: Child =
      modelOptions.length > 0
        ? selectInput(modelOptions, currentModel, (value) => void patch({ ai: { activeModel: value } }))
        : h('div', { class: 'field-hint' }, 'Список пуст — нажмите «Проверить подключение»');

    /** Проверка = единственное действие, которое и ключ сохранит, и модели подтянет. */
    async function runTest(): Promise<void> {
      if (!provider) return;
      testResult = { ok: true, message: 'Проверяем подключение…' };
      render();

      const apiKey = keyInput.value.trim();
      try {
        const result = await deps.rpc.request('ai.test', {
          baseUrl: baseUrlInput.value.trim() || provider.baseUrl,
          apiKey: apiKey || undefined,
          providerId: provider.id,
        });
        testResult = { ok: result.ok, message: result.message };

        if (result.ok) {
          testedModels = result.models;
          if (apiKey) settings = await deps.rpc.request('ai.setApiKey', { providerId: provider.id, apiKey });
          const patchValue: AiProviderPatch = { id: provider.id, models: result.models };
          if (result.models.length > 0 && !provider.defaultModel) patchValue.defaultModel = result.models[0];
          settings = await deps.rpc.request('settings.update', { ai: { provider: patchValue } });
        }
      } catch (error) {
        testResult = { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
      render();
    }

    /** Убрать сохранённый ключ: подсказка вернётся к «Ключ не задан». */
    async function clearKey(): Promise<void> {
      if (!provider) return;
      settings = await deps.rpc.request('ai.clearApiKey', { providerId: provider.id });
      testResult = null;
      testedModels = [];
      render();
    }

    // Ключ сервиса поиска сохраняется отдельной кнопкой, как ключ провайдера:
    // он не часть обычной правки настроек и обратно в renderer не возвращается.
    const webSearchKeyInput = h('input', {
      class: 'field-input',
      type: 'password',
      placeholder: ai.webSearch.hasApiKey ? 'Ключ сохранён — введите новый, чтобы заменить' : 'Ключ сервиса поиска',
    });

    async function saveWebSearchKey(): Promise<void> {
      const value = webSearchKeyInput.value.trim();
      if (!value) return;
      settings = await deps.rpc.request('ai.setWebSearchKey', { apiKey: value });
      render();
    }

    async function clearWebSearchKey(): Promise<void> {
      settings = await deps.rpc.request('ai.clearWebSearchKey');
      render();
    }

    const webSearchKeyField =
      ai.webSearch.provider === 'brave'
        ? field(
            'Ключ Brave',
            h(
              'div',
              { class: 'field-row' },
              webSearchKeyInput,
              h(
                'button',
                { class: 'btn btn-small', type: 'button', onClick: () => void saveWebSearchKey() },
                'Сохранить ключ',
              ),
              ai.webSearch.hasApiKey
                ? h(
                    'button',
                    { class: 'btn btn-small', type: 'button', onClick: () => void clearWebSearchKey() },
                    'Убрать ключ',
                  )
                : null,
            ),
          )
        : h(
            'div',
            { class: 'field-hint' },
            ai.webSearch.hasApiKey
              ? 'Свой SearxNG обычно работает без ключа; ключ можно убрать в поле выше, если адрес его не требует.'
              : 'SearxNG ключа не требует — достаточно адреса сервиса.',
          );

    const prompt = h('textarea', { class: 'field-input', rows: 5, spellcheck: false });
    prompt.value = ai.systemPrompt;
    prompt.addEventListener('change', () => void patch({ ai: { systemPrompt: prompt.value } }));

    return [
      switchRow('Ассистент включён', ai.enabled, (value) => void patch({ ai: { enabled: value } }, true)),
      h(
        'div',
        { class: 'field-hint' },
        'Мастер-выключатель: снятая галочка глушит AI целиком — панель чата, команды «Объяснить/Исправить ' +
          'выделение» и любые запросы к провайдеру. Редактор, файлы и терминал работают как обычно, ' +
          'а провайдеры, модели и ключи остаются на месте.',
      ),
      h('div', { class: 'settings-divider' }),
      field('Провайдер', h('div', { class: 'field-row' }, providerSelect.element, removeButton)),
      field('Добавить провайдера', h('div', { class: 'field-row' }, presetSelect.element, addButton)),
      h('div', { class: 'settings-divider' }),
      h('div', { class: 'field-label' }, `Подключение: ${provider?.label ?? 'не выбран'}`),
      field('Название', labelInput),
      field('Адрес API', baseUrlInput),
      preset ? h('div', { class: 'field-hint' }, preset.hint) : null,
      field(
        'API-ключ',
        h('div', { class: 'field-row' }, keyInput, testButton, provider?.hasApiKey ? clearKeyButton : null),
      ),
      status,
      h('div', { class: 'field-hint' }, 'Ключ хранится в main-процессе и в renderer не попадает.'),
      field('Модель', modelField),
      h('div', { class: 'settings-divider' }),
      field(
        'Усилие размышления',
        selectInput(
          [
            { value: 'off', label: 'Без размышлений' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
          ],
          ai.reasoningEffort ?? 'off',
          (value) => void patch({ ai: { reasoningEffort: value as ReasoningEffort } }, true),
        ),
      ),
      h(
        'div',
        { class: 'field-hint' },
        'Сколько модель думает перед ответом. Отправляется только тем моделям, которые это понимают: ' +
          'у остальных параметр не уходит, чтобы не ломать запрос.',
      ),
      field(
        'Температура',
        numberInput(ai.temperature, 0, 2, 0.1, (value) => void patch({ ai: { temperature: value } })),
      ),
      h(
        'div',
        { class: 'field-hint' },
        'Температура не отправляется моделям с фиксированным размышлением (o-серия, deepseek-reasoner) — они её не принимают.',
      ),
      field(
        'Максимум токенов ответа',
        numberInput(ai.maxTokens, 256, 1_000_000, 256, (value) => void patch({ ai: { maxTokens: value } })),
      ),
      h(
        'div',
        { class: 'field-hint' },
        'Сколько токенов модель может написать в ответе. Большие значения (вплоть до 1 000 000) ' +
          'уместны для моделей с широким лимитом; если модель ответит ошибкой про лимит — уменьшите число.',
      ),
      field(
        'Шагов агента',
        numberInput(ai.maxSteps, 1, 500, 1, (value) => void patch({ ai: { maxSteps: value } })),
      ),
      field(
        'Шагов агента при полном доступе',
        numberInput(ai.maxAutopilotSteps, 1, 500, 1, (value) => void patch({ ai: { maxAutopilotSteps: value } })),
      ),
      h(
        'div',
        { class: 'field-hint' },
        'Страховка от зацикливания: сколько раз агент может сходить «инструмент → модель» до остановки. ' +
          'При полном доступе задача длиннее, поэтому лимит свой.',
      ),
      switchRow(
        'Спрашивать перед опасными командами при полном доступе',
        ai.confirmDangerous,
        (value) => void patch({ ai: { confirmDangerous: value } }),
      ),
      h(
        'div',
        { class: 'field-hint' },
        'По умолчанию включено: даже полный доступ спрашивает перед необратимыми командами ' +
          '(удаление, запись на диск, sudo, git push --force). Выключите, если хотите совсем без вопросов — ' +
          'тогда команды исполняются молча. На отдельные безобидные команды подсказка может сработать зря — ' +
          'страховка склонна спросить лишний раз.',
      ),
      switchRow(
        'Сжимать вывод инструментов',
        ai.compressOutput,
        (value) => void patch({ ai: { compressOutput: value } }),
      ),
      h(
        'div',
        { class: 'field-hint' },
        'Перед отправкой модели из вывода команд убирается оформление: прогресс-бары и спиннеры, ' +
          'служебные последовательности терминала, повторы одинаковых строк и пустые простыни. ' +
          'Содержание — код, диффы, ошибки — не меняется, а в карточке инструмента человек ' +
          'по-прежнему видит полный вывод.',
      ),
      h('div', { class: 'settings-divider' }),
      switchRow(
        'Веб-поиск (инструмент web_search)',
        ai.webSearch.enabled,
        (value) => void patch({ ai: { webSearch: { enabled: value } } }),
      ),
      h(
        'div',
        { class: 'field-hint' },
        'Даёт ассистенту искать в интернете: документация и внешние сведения, которых нет в проекте. ' +
          'Это единственное действие агента, которое ходит наружу, поэтому выключено по умолчанию. ' +
          'Обратный адрес задаёте вы — модель влияет только на запрос.',
      ),
      field(
        'Сервис поиска',
        selectInput(
          [
            { value: 'searxng', label: 'SearxNG (свой сервер, ключ не нужен)' },
            { value: 'brave', label: 'Brave Search API (нужен ключ)' },
          ],
          ai.webSearch.provider,
          (value) => void patch({ ai: { webSearch: { provider: value as WebSearchProvider } } }),
        ),
      ),
      field(
        'Адрес сервиса',
        textInput(ai.webSearch.endpoint, (value) => void patch({ ai: { webSearch: { endpoint: value } } })),
      ),
      h(
        'div',
        { class: 'field-hint' },
        ai.webSearch.provider === 'searxng'
          ? 'Пусто — адрес по умолчанию http://localhost:8080 (своя установка SearxNG). ' +
              'Открытый http допускается только для localhost и частных адресов: остальное — по https.'
          : 'Пусто — адрес по умолчанию https://api.search.brave.com/res/v1/web/search.',
      ),
      webSearchKeyField,
      field(
        'Контекстное окно (токенов)',
        numberInput(ai.contextWindow ?? 0, 0, 2_000_000, 1000, (value) => void patch({ ai: { contextWindow: value } })),
      ),
      h(
        'div',
        { class: 'field-hint' },
        'Размер входного окна модели — по нему считается заполнение контекста и кнопка «Сжать беседу». ' +
          '0 — определять автоматически по имени модели (например, Gemini ≈ 1 000 000, GPT-4o ≈ 128 000).',
      ),
      field(
        'Сжимать беседу при (токенов)',
        numberInput(
          ai.compactAtTokens,
          0,
          2_000_000,
          10_000,
          (value) => void patch({ ai: { compactAtTokens: value } }),
        ),
      ),
      h(
        'div',
        { class: 'field-hint' },
        'Верхний предел истории: беседа длиннее него сжимается автоматически, даже если до конца окна далеко. ' +
          'На моделях с огромным окном без этого предела контекст растёт слишком дорого. ' +
          '0 — сжимать только при подходе к окну модели.',
      ),
      field(
        'Модель для сжатия беседы',
        textInput(ai.compactModel ?? '', (value) => void patch({ ai: { compactModel: value } })),
      ),
      h(
        'div',
        { class: 'field-hint' },
        'Пусто — сжимаем активной моделью. Сжатие — простая задача: небольшая модель сделает его дешевле ' +
          'и не займёт окно основной. Проверьте, что модель доступна у текущего провайдера.',
      ),
      field('Системный промпт', prompt),
    ];
  }

  /* ── провайдеры ────────────────────────────────────────────────────────── */

  /** Пресет подставляется целиком: адрес и стартовый список моделей — без ручного ввода. */
  async function addProvider(presetId: string): Promise<void> {
    const preset = findProviderPreset(presetId);
    if (!preset || settings === null) return;

    const known = settings.ai.providers.some((item) => item.id === preset.id);
    if (!known) {
      const provider: AiProviderPatch = {
        id: preset.id,
        label: preset.label,
        baseUrl: preset.baseUrl,
        models: [...preset.models],
      };
      if (preset.defaultModel) provider.defaultModel = preset.defaultModel;
      if (preset.protocol) provider.protocol = preset.protocol;
      await patch({ ai: { provider } });
    }

    testedModels = [];
    testResult = null;
    await patch({ ai: { activeProviderId: preset.id } }, true);
    showToast(known ? `«${preset.label}» уже в списке` : `Добавлен провайдер «${preset.label}»`);
  }

  async function removeProvider(providerId: string): Promise<void> {
    if (!providerId || settings === null) return;
    const target = settings.ai.providers.find((item) => item.id === providerId);

    const { confirmed } = await deps.rpc.request('dialog.confirm', {
      title: 'Удалить провайдера',
      message: `Убрать «${target?.label ?? providerId}» из списка?`,
      detail: 'Ключ и настройки этого провайдера будут забыты.',
      confirmLabel: 'Удалить',
    });
    if (!confirmed) return;

    testedModels = [];
    testResult = null;
    await patch({ ai: { removeProviderId: providerId } }, true);
  }

  async function patchProvider(values: AiProviderPatch): Promise<void> {
    await patch({ ai: { provider: values } }, true);
  }

  function renderEditor(): Child[] {
    const editor: EditorSettings = settings!.editor;
    const editable = (values: Partial<EditorSettings>): void => void patch({ editor: values });
    // Подсветка неиспользуемого кода — проверка JS/TS в редакторе; в Python-проекте
    // её показывать нечего, там этим занимается языковой сервер.
    const showUnused = (deps.project?.kind() ?? null) !== 'python';
    return [
      h('div', { class: 'field-label' }, 'Шрифт'),
      field(
        'Размер шрифта',
        numberInput(editor.fontSize, 8, 32, 1, (value) => editable({ fontSize: value })),
      ),
      switchRow('Лигатуры шрифта', editor.fontLigatures, (value) => editable({ fontLigatures: value })),
      h('div', { class: 'field-hint' }, 'Связки символов (`=>`, `!==`, `!=`) одним знаком — свойство JetBrains Mono.'),

      h('div', { class: 'settings-divider' }),
      h('div', { class: 'field-label' }, 'Отступы и строки'),
      field(
        'Размер отступа',
        selectInput(
          [
            { value: '2', label: '2 пробела' },
            { value: '4', label: '4 пробела' },
            { value: '8', label: '8 пробелов' },
          ],
          String(editor.tabSize),
          (value) => editable({ tabSize: Number(value) }),
        ),
      ),
      switchRow('Отступы пробелами', editor.insertSpaces, (value) => editable({ insertSpaces: value })),
      switchRow('Язык задаёт отступы', editor.languageIndent, (value) => editable({ languageIndent: value })),
      h(
        'div',
        { class: 'field-hint' },
        'Python получает 4 пробела, Makefile — символ табуляции, TypeScript — 2 пробела. Выключено — везде общие значения сверху.',
      ),
      field(
        'Перенос длинных строк',
        selectInput(
          [
            { value: 'off', label: 'Выключен' },
            { value: 'on', label: 'По ширине окна' },
          ],
          editor.wordWrap ? 'on' : 'off',
          (value) => editable({ wordWrap: value === 'on' }),
        ),
      ),
      field(
        'Невидимые символы',
        selectInput(
          [
            { value: 'none', label: 'Не показывать' },
            { value: 'selection', label: 'В выделении' },
            { value: 'boundary', label: 'По краям слов' },
            { value: 'trailing', label: 'Пробелы в конце строк' },
            { value: 'all', label: 'Всегда' },
          ],
          editor.renderWhitespace,
          (value) => editable({ renderWhitespace: value as EditorSettings['renderWhitespace'] }),
        ),
      ),

      h('div', { class: 'settings-divider' }),
      h('div', { class: 'field-label' }, 'Вид редактора'),
      switchRow('Показывать миникарту', editor.minimap, (value) => editable({ minimap: value })),
      switchRow('Номера строк', editor.lineNumbers !== 'off', (value) =>
        editable({ lineNumbers: value ? 'on' : 'off' }),
      ),
      switchRow('Подсвечивать строку курсора', editor.renderLineHighlight !== 'none', (value) =>
        editable({ renderLineHighlight: value ? 'all' : 'none' }),
      ),
      switchRow('Разноцветные парные скобки', editor.bracketPairColorization, (value) =>
        editable({ bracketPairColorization: value }),
      ),
      switchRow('Липкий заголовок блока', editor.stickyScroll, (value) => editable({ stickyScroll: value })),
      switchRow('Плавная прокрутка', editor.smoothScrolling, (value) => editable({ smoothScrolling: value })),
      switchRow('Прокрутка за последнюю строку', editor.scrollBeyondLastLine, (value) =>
        editable({ scrollBeyondLastLine: value }),
      ),

      h('div', { class: 'settings-divider' }),
      h('div', { class: 'field-label' }, 'Подсказки и проверки'),
      switchRow('Подсказки по мере ввода', editor.quickSuggestions, (value) => editable({ quickSuggestions: value })),
      ...(showUnused
        ? [
            switchRow('Подсвечивать неиспользуемый код', editor.showUnused, (value) => editable({ showUnused: value })),
            h(
              'div',
              { class: 'field-hint' },
              'Проверка JavaScript и TypeScript работает в самом редакторе: неиспользуемые импорты и переменные подчёркиваются сразу.',
            ),
          ]
        : []),
      switchRow('Форматировать при сохранении', editor.formatOnSave, (value) => editable({ formatOnSave: value })),
      field(
        'Мигание курсора',
        selectInput(
          [
            { value: 'blink', label: 'Мигает' },
            { value: 'smooth', label: 'Плавно' },
            { value: 'phase', label: 'Волной' },
            { value: 'expand', label: 'Растёт' },
            { value: 'solid', label: 'Не мигает' },
          ],
          editor.cursorBlinking,
          (value) => editable({ cursorBlinking: value as EditorSettings['cursorBlinking'] }),
        ),
      ),
    ];
  }

  function renderExplorer(): Child[] {
    const explorer: ExplorerSettings = settings!.explorer;
    const apply = (values: Partial<ExplorerSettings>): void => void patch({ explorer: values });

    const exclude = h('textarea', {
      class: 'field-input',
      rows: 3,
      spellcheck: false,
      placeholder: 'node_modules\n*.min.js',
    });
    exclude.value = explorer.exclude.join('\n');
    exclude.addEventListener('change', () => {
      const patterns = exclude.value
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      apply({ exclude: patterns });
    });

    return [
      h('div', { class: 'field-label' }, 'Вид дерева'),
      switchRow('Значки по виду файла', explorer.icons, (value) => apply({ icons: value })),
      h(
        'div',
        { class: 'field-hint' },
        'Цветной значок говорит о языке и типе файла: JS, Python, JSON, папка с исходниками.',
      ),
      field(
        'Плотность строк',
        selectInput(
          [
            { value: 'compact', label: 'Компактно' },
            { value: 'normal', label: 'Обычно' },
            { value: 'cozy', label: 'Просторно' },
          ],
          explorer.rowDensity,
          (value) => apply({ rowDensity: value as ExplorerSettings['rowDensity'] }),
        ),
      ),
      field(
        'Отступ уровня, px',
        numberInput(explorer.indent, 6, 32, 2, (value) => apply({ indent: value })),
      ),

      h('div', { class: 'settings-divider' }),
      h('div', { class: 'field-label' }, 'Содержимое'),
      switchRow('Показывать скрытые файлы', explorer.showHidden, (value) => apply({ showHidden: value })),
      switchRow('Папки выше файлов', explorer.foldersFirst, (value) => apply({ foldersFirst: value })),
      field(
        'Сортировка',
        selectInput(
          [
            { value: 'name', label: 'По имени' },
            { value: 'type', label: 'По типу файла' },
          ],
          explorer.sort,
          (value) => apply({ sort: value as ExplorerSettings['sort'] }),
        ),
      ),
      field('Что не показывать', exclude),
      h(
        'div',
        { class: 'field-hint' },
        'По строке на шаблон: `*.min.js`, `coverage`, `dist`. Поддерживаются `*`, `?` и `**`.',
      ),

      h('div', { class: 'settings-divider' }),
      h('div', { class: 'field-label' }, 'Поведение'),
      switchRow('Открывать файл одним кликом', explorer.openOnSingleClick, (value) =>
        apply({ openOnSingleClick: value }),
      ),
      h('div', { class: 'field-hint' }, 'Выключено — как в PyCharm: одинарный клик выделяет, двойной открывает.'),
      switchRow('Пометки git у файлов', explorer.gitDecorations, (value) => apply({ gitDecorations: value })),
      switchRow('Точка у папок с правками', explorer.folderChangeDot, (value) => apply({ folderChangeDot: value })),
      switchRow('Спрашивать перед удалением', explorer.confirmDelete, (value) => apply({ confirmDelete: value })),
    ];
  }

  function renderRun(): Child[] {
    const run: RunSettings = settings!.run;
    const apply = (values: Partial<RunSettings>): void => void patch({ run: values });
    const kind = deps.project?.kind() ?? null;
    const showNode = kind !== 'python';
    const showPython = kind !== 'node';

    const items: Child[] = [];

    if (showNode) {
      items.push(
        field(
          'Менеджер пакетов Node',
          selectInput(
            [
              { value: 'auto', label: 'Автоматически' },
              { value: 'npm', label: 'npm' },
              { value: 'pnpm', label: 'pnpm' },
              { value: 'yarn', label: 'yarn' },
              { value: 'bun', label: 'bun' },
            ],
            run.packageManager,
            (value) => apply({ packageManager: value as RunSettings['packageManager'] }),
          ),
        ),
        h(
          'div',
          { class: 'field-hint' },
          '«Автоматически» — по файлу блокировки в корне проекта: pnpm-lock.yaml, yarn.lock, bun.lockb, package-lock.json.',
        ),
      );
    }

    if (showPython) {
      const pythonPath = textInput(run.pythonPath, (value) => apply({ pythonPath: value }));
      pythonPath.placeholder = 'например, /usr/bin/python3 или .venv/bin/python';
      items.push(
        field('Интерпретатор Python', pythonPath),
        h(
          'div',
          { class: 'field-hint' },
          'Пусто — берём окружение проекта (`.venv/bin/python`), а без него системный `python3`. Путь с пробелами подставляется в команду в кавычках.',
        ),
      );
    }

    // Подсказка про запуск — про то, что есть в этом проекте: у Python нет
    // задач из package.json, у Node — интерпретатора из venv.
    const runHint =
      kind === 'python'
        ? 'Кнопка запуска появляется сама для запускаемых Python-файлов и тестов. Горячие клавиши: Ctrl+F5 — запустить, Shift+F10 — выбрать.'
        : kind === 'node'
          ? 'Кнопка запуска появляется сама: файл, если он запускаемый, и задачи из `scripts` в package.json. Горячие клавиши: Ctrl+F5 — запустить, Shift+F10 — выбрать.'
          : 'Кнопка запуска появляется сама: Python и Node — файлом, если он запускаемый, и всегда — задачами из `scripts` в package.json. Горячие клавиши: Ctrl+F5 — запустить, Shift+F10 — выбрать.';

    items.push(
      switchRow('Сохранять файлы перед запуском', run.saveBeforeRun, (value) => apply({ saveBeforeRun: value })),
      h('div', { class: 'settings-divider' }),
      h('div', { class: 'field-label' }, 'Что можно запустить'),
      h('div', { class: 'field-hint' }, runHint),
    );

    return items;
  }

  function renderAppearance(): Child[] {
    return [
      field(
        'Тема',
        selectInput(
          THEME_OPTIONS.map((item) => ({ value: item.value, label: item.label })),
          settings!.appearance.theme,
          (value) => {
            void deps.theme.set(value as ThemeChoice);
          },
        ),
      ),
      h('div', { class: 'field-hint' }, '«Как в системе» переключает палитру вслед за схемой рабочего стола.'),
    ];
  }

  /**
   * Внешние инструменты (MCP). Список серверов редактируется JSON-полем — так же,
   * как серверы LSP: команда с аргументами и окружением в одну строку не влезает,
   * а привычка к формату у человека уже есть.
   *
   * Кнопка проверки поднимает серверы и показывает их инструменты: без неё
   * настройка слепа, и об ошибке (нет команды, сервер молчит) видно только в
   * консоли main.
   */
  function renderMcp(): Child[] {
    const servers = h('textarea', { class: 'field-input', rows: 8, spellcheck: false });
    servers.value = JSON.stringify(settings!.ai.mcpServers, null, 2);
    servers.addEventListener('change', () => {
      try {
        const parsed = JSON.parse(servers.value) as unknown;
        if (!Array.isArray(parsed)) throw new Error('ожидался массив серверов');
        void patch({ ai: { mcpServers: parsed as McpServerConfig[] } }, true);
      } catch (error) {
        showToast(error instanceof Error ? error.message : 'Некорректный JSON', 'error');
      }
    });

    const checkButton = h('button', { class: 'btn btn-small', type: 'button' }, 'Проверить серверы');
    checkButton.addEventListener('click', () => {
      checkButton.disabled = true;
      mcpStatus = 'Поднимаю серверы…';
      render();
      void deps.rpc
        .request('ai.mcpTools')
        .then((list) => {
          mcpStatus = describeMcpStatus(list);
          render();
        })
        .catch((error) => {
          mcpStatus = error instanceof Error ? error.message : String(error);
          render();
        })
        .finally(() => {
          checkButton.disabled = false;
        });
    });

    const example = JSON.stringify(
      [{ id: 'files', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'], enabled: true }],
      null,
      2,
    );

    return [
      field('Серверы MCP (JSON)', servers),
      h(
        'div',
        { class: 'field-hint' },
        'Каждый сервер IDE запускает отдельным процессом и говорит с ним по stdio. Инструменты сервера ' +
          'попадают модели вместе со встроенными, с именем mcp__<сервер>__<инструмент>. Нужны Node и npx ' +
          'в PATH — команду запуска вы задаёте здесь, агент её не меняет.',
      ),
      field('Проверить', checkButton),
      mcpStatus ? h('div', { class: 'field-hint' }, mcpStatus) : null,
      h(
        'div',
        { class: 'field-hint' },
        'Инструмент, который сервер не пометил как «только чтение» (readOnlyHint), спрашивает ' +
          'подтверждение — как команда в терминале. В режиме плана внешние инструменты не предлагаются. ' +
          'Нерабочий сервер остальные не ломает: причина уходит в консоль.',
      ),
      h('div', { class: 'field-hint' }, `Пример: ${example}`),
    ];
  }

  function renderLsp(): Child[] {
    const lsp = settings!.lsp;
    // Показываем серверы только языков этого проекта; остальные не теряем —
    // держим в стороне и возвращаем назад при сохранении.
    const languages = lspLanguagesForKind(deps.project?.kind() ?? null);
    const isOwn = (server: LspServerConfig): boolean => !languages || languages.includes(server.language);
    const foreign = languages ? lsp.servers.filter((server) => !isOwn(server)) : [];
    const visible = lsp.servers.filter(isOwn);

    const servers = h('textarea', { class: 'field-input', rows: 8, spellcheck: false });
    servers.value = JSON.stringify(visible, null, 2);
    servers.addEventListener('change', () => {
      try {
        const parsed = JSON.parse(servers.value) as unknown;
        if (!Array.isArray(parsed)) throw new Error('ожидался массив');
        void patch({ lsp: { servers: [...foreign, ...(parsed as LspServerConfig[])] } }, true);
      } catch (error) {
        showToast(error instanceof Error ? error.message : 'Некорректный JSON', 'error');
      }
    });

    // Поиск установленных серверов: команды ищутся в PATH в main, здесь только
    // показываем найденное и подставляем в список — автозапуска без ведома нет.
    const detectButton = h('button', { class: 'btn btn-small', type: 'button' }, 'Найти установленные');
    detectButton.addEventListener('click', () => {
      detectButton.disabled = true;
      void deps.rpc
        .request('lsp.detect')
        .then((found) => {
          const relevant = found.filter(isOwn);
          if (relevant.length === 0) {
            showToast('Языковые серверы в PATH не найдены', 'error');
            return;
          }
          servers.value = JSON.stringify(relevant, null, 2);
          void patch({ lsp: { servers: [...foreign, ...relevant], enabled: true } }, true);
          showToast(`Найдено серверов: ${relevant.length}`);
        })
        .catch((error) => showToast(error instanceof Error ? error.message : String(error), 'error'))
        .finally(() => {
          detectButton.disabled = false;
        });
    });

    // Живой статус: какие серверы подняты прямо сейчас, и кнопка их перезапуска.
    // Перезапуск нужен, когда сервер завис или подхватил не то окружение.
    const restartButton = h('button', { class: 'btn btn-small', type: 'button' }, 'Перезапустить');
    restartButton.addEventListener('click', () => {
      restartButton.disabled = true;
      void deps.rpc
        .request('lsp.restart')
        .then((result) => {
          lspRunning = result.running;
          render();
          showToast('Серверы остановлены — поднимутся при следующем открытии файла');
        })
        .catch((error) => {
          showToast(error instanceof Error ? error.message : String(error), 'error');
          restartButton.disabled = false;
        });
    });
    const statusText =
      lspRunning === null
        ? 'Смотрю запущенные серверы…'
        : lspRunning.length > 0
          ? `Сейчас запущены: ${lspRunning.join(', ')}`
          : 'Сейчас ничего не запущено';

    return [
      switchRow('Запускать языковые серверы', lsp.enabled, (value) => void patch({ lsp: { enabled: value } }, true)),
      h(
        'div',
        { class: 'field-hint' },
        'Сервер поднимается при первом открытии файла его языка и живёт до выхода из приложения. ' +
          'Его пометки показываются в редакторе рядом с собственными.',
      ),
      h('div', { class: 'field-hint' }, statusText),
      field('Перезапустить', restartButton),
      field('Серверы (JSON)', servers),
      languages
        ? h(
            'div',
            { class: 'field-hint' },
            `Показаны только серверы языков этого проекта: ${languages.join(', ')}. ` +
              'Прочие сохранены и вернутся, когда откроется проект другого вида.',
          )
        : null,
      field('Найти серверы', detectButton),
      h(
        'div',
        { class: 'field-hint' },
        'Кнопка проверяет PATH и подставляет найденное (pylsp/pyright, typescript-language-server, ' +
          'rust-analyzer, gopls и другие). Запускать сервер без вашего ведома IDE не станет.',
      ),
      h(
        'div',
        { class: 'field-hint' },
        'Вручную: [{"language":"python","command":"pylsp","args":[],"enabled":true}] — команда должна быть в PATH.',
      ),
    ];
  }

  function renderProject(): Child[] {
    const list = h('div', { class: 'recent-list' });

    if (recent.length === 0) {
      list.appendChild(h('div', { class: 'field-hint' }, 'Список пуст.'));
    }

    for (const project of recent) {
      list.appendChild(
        h(
          'div',
          { class: 'recent-item' },
          svgIcon('panel', 12),
          h('span', { class: 'recent-name', title: project.path }, project.name),
          project.exists ? null : h('span', { class: 'field-hint' }, 'папки нет'),
          h(
            'button',
            {
              class: 'icon-btn',
              type: 'button',
              title: 'Убрать из списка',
              onClick: () => void forget(project.path),
            },
            svgIcon('close', 12),
          ),
        ),
      );
    }

    return [
      h(
        'div',
        { class: 'field field-between' },
        h('span', {}, 'Файл настроек'),
        h(
          'button',
          {
            class: 'btn btn-small',
            type: 'button',
            onClick: () => {
              close();
              void deps.commands.execute('settings.revealFile');
            },
          },
          'Открыть settings.json',
        ),
      ),
      h('div', { class: 'field-label' }, 'Недавние проекты'),
      list,
    ];
  }

  async function forget(path: string): Promise<void> {
    try {
      recent = await deps.rpc.request('app.forgetProject', { path });
      render();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  /* ── отрисовка ─────────────────────────────────────────────────────────── */

  /** Раздел настроек по его id: общий путь для обычного вида и поиска. */
  function sectionContent(id: SectionId): Child[] {
    if (id === 'ai') return renderAi();
    if (id === 'editor') return renderEditor();
    if (id === 'explorer') return renderExplorer();
    if (id === 'run') return renderRun();
    if (id === 'appearance') return renderAppearance();
    if (id === 'lsp') return renderLsp();
    if (id === 'mcp') return renderMcp();
    return renderProject();
  }

  /**
   * Поля разделов, подпись которых содержит запрос. Ищем только по `.field`:
   * заголовки групп и подсказки — не настройки, в выдаче они были бы шумом.
   * Разделы строятся целиком: «поискать по готовому» дешевле, чем держать рядом
   * вторую таблицу подписей, которая со временем разойдётся с самими полями.
   */
  function searchMatches(needle: string): Map<SectionId, HTMLElement[]> {
    const found = new Map<SectionId, HTMLElement[]>();
    for (const item of SECTIONS) {
      const hits = sectionContent(item.id).filter(
        (child): child is HTMLElement =>
          child instanceof HTMLElement &&
          child.classList.contains('field') &&
          (child.textContent ?? '').toLowerCase().includes(needle),
      );
      if (hits.length > 0) found.set(item.id, hits);
    }
    return found;
  }

  /** Перейти в раздел: поиск при этом снимается — так виден целый раздел. */
  function openSection(id: SectionId): void {
    section = id;
    query = '';
    search.value = '';
    render();
  }

  /**
   * Выдача поиска: находки сгруппированы по разделам. Заголовок группы — кнопка
   * перехода в раздел: найденное поле меняют в окружении остальных настроек.
   */
  function renderSearchResults(matches: ReadonlyMap<SectionId, HTMLElement[]>): void {
    let total = 0;
    for (const item of SECTIONS) {
      const hits = matches.get(item.id);
      if (!hits?.length) continue;
      total += hits.length;
      pane.appendChild(
        h(
          'button',
          { class: 'settings-search-group', type: 'button', onClick: () => openSection(item.id) },
          svgIcon(item.icon, 13),
          h('span', {}, item.title),
          h('span', { class: 'settings-search-count' }, String(hits.length)),
        ),
      );
      for (const hit of hits) pane.appendChild(hit);
    }
    if (total === 0) {
      pane.appendChild(h('div', { class: 'field-hint' }, `Ничего не найдено по «${query.trim()}».`));
    }
    pane.scrollTop = 0;
  }

  function render(): void {
    if (settings === null) return;

    const needle = query.trim().toLowerCase();
    const matches = needle ? searchMatches(needle) : null;

    clear(nav);
    for (const item of SECTIONS) {
      const hits = matches?.get(item.id)?.length ?? 0;
      const button = h(
        'button',
        {
          // При поиске активный раздел не подсвечиваем: панель показывает выдачу,
          // а не раздел, — подсветка обещала бы не то, что видно. Разделы без
          // находок приглушены, а рядом с остальными стоит их число.
          class:
            `modal-nav-item${!needle && item.id === section ? ' is-active' : ''}` +
            `${needle && hits === 0 ? ' is-dimmed' : ''}`,
          type: 'button',
          onClick: () => openSection(item.id),
        },
        svgIcon(item.icon, 14),
        h('span', {}, item.title),
        needle && hits > 0 ? h('span', { class: 'modal-nav-count' }, String(hits)) : null,
      );
      nav.appendChild(button);
    }

    // Открыли раздел LSP, а статуса ещё нет — спросим. Один раз: ответ перерисует
    // панель, и повторно дёргать main на каждую отрисовку незачем.
    if (section === 'lsp' && lspRunning === null) void refreshLspStatus();

    clear(pane);
    if (needle && matches) renderSearchResults(matches);
    else {
      append(pane, sectionContent(section));
      pane.scrollTop = 0;
    }
    title.textContent = needle
      ? `Настройки · поиск: ${query.trim()}`
      : `Настройки · ${SECTIONS.find((item) => item.id === section)?.title ?? ''}`;
  }

  return { element, open, close, applySettings };
}
