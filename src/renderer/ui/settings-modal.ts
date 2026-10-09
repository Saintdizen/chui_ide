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
import type { AiProviderPatch } from '../../shared/api';
import { PROVIDER_PRESETS, findProviderPreset } from '../../shared/providers';
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

type SectionId = 'ai' | 'editor' | 'explorer' | 'run' | 'appearance' | 'project' | 'lsp';

const SECTIONS: ReadonlyArray<{ id: SectionId; title: string; icon: 'sparkle' | 'file' | 'sun' | 'panel' | 'folder' | 'play' | 'command' }> = [
  { id: 'ai', title: 'AI', icon: 'sparkle' },
  { id: 'editor', title: 'Редактор', icon: 'file' },
  { id: 'explorer', title: 'Проводник', icon: 'folder' },
  { id: 'run', title: 'Запуск', icon: 'play' },
  { id: 'appearance', title: 'Внешний вид', icon: 'sun' },
  { id: 'lsp', title: 'Языки (LSP)', icon: 'command' },
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
  let recent: RecentProject[] = [];
  /** Итог последней проверки подключения: показываем прямо в панели. */
  let testResult: { ok: boolean; message: string } | null = null;
  /** Модели, которые отдал провайдер при проверке. */
  let testedModels: string[] = [];

  const nav = h('nav', { class: 'modal-nav' });
  const pane = h('div', { class: 'modal-pane' });
  const title = h('span', { class: 'modal-title' }, 'Настройки');

  const closeButton = h('button', { class: 'icon-btn', type: 'button', title: 'Закрыть (Esc)', onClick: () => close() }, svgIcon('close', 15));

  const element = h(
    'div',
    { class: 'modal-backdrop', hidden: true },
    h(
      'div',
      { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Настройки приложения' },
      h('header', { class: 'modal-header' }, svgIcon('settings', 15), title, closeButton),
      h('div', { class: 'modal-body' }, nav, pane),
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
      settings = await deps.rpc.request('settings.update', value);
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

  function numberInput(value: number, min: number, max: number, step: number, onCommit: (next: number) => void): HTMLInputElement {
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
    if (currentModel && !models.includes(currentModel)) modelOptions.unshift({ value: currentModel, label: currentModel });

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
      field('API-ключ', h('div', { class: 'field-row' }, keyInput, testButton)),
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
      field('Температура', numberInput(ai.temperature, 0, 2, 0.1, (value) => void patch({ ai: { temperature: value } }))),
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
      field('Шагов агента', numberInput(ai.maxSteps, 1, 500, 1, (value) => void patch({ ai: { maxSteps: value } }))),
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
        'По умолчанию выключено: полный доступ — без вопросов. Включите, чтобы даже с ним ' +
          'спрашивать перед необратимыми командами (удаление, запись на диск, sudo, git push --force). ' +
          'На отдельные безобидные команды подсказка может сработать зря — страховка склонна спросить лишний раз.',
      ),
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
    return [
      h('div', { class: 'field-label' }, 'Шрифт'),
      field('Размер шрифта', numberInput(editor.fontSize, 8, 32, 1, (value) => editable({ fontSize: value }))),
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
      switchRow('Номера строк', editor.lineNumbers !== 'off', (value) => editable({ lineNumbers: value ? 'on' : 'off' })),
      switchRow('Подсвечивать строку курсора', editor.renderLineHighlight !== 'none', (value) =>
        editable({ renderLineHighlight: value ? 'all' : 'none' }),
      ),
      switchRow('Разноцветные парные скобки', editor.bracketPairColorization, (value) => editable({ bracketPairColorization: value })),
      switchRow('Липкий заголовок блока', editor.stickyScroll, (value) => editable({ stickyScroll: value })),
      switchRow('Плавная прокрутка', editor.smoothScrolling, (value) => editable({ smoothScrolling: value })),
      switchRow('Прокрутка за последнюю строку', editor.scrollBeyondLastLine, (value) => editable({ scrollBeyondLastLine: value })),

      h('div', { class: 'settings-divider' }),
      h('div', { class: 'field-label' }, 'Подсказки и проверки'),
      switchRow('Подсказки по мере ввода', editor.quickSuggestions, (value) => editable({ quickSuggestions: value })),
      switchRow('Подсвечивать неиспользуемый код', editor.showUnused, (value) => editable({ showUnused: value })),
      h(
        'div',
        { class: 'field-hint' },
        'Проверка JavaScript и TypeScript работает в самом редакторе: неиспользуемые импорты и переменные подчёркиваются сразу.',
      ),
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

    const exclude = h('textarea', { class: 'field-input', rows: 3, spellcheck: false, placeholder: 'node_modules\n*.min.js' });
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
      h('div', { class: 'field-hint' }, 'Цветной значок говорит о языке и типе файла: JS, Python, JSON, папка с исходниками.'),
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
      field('Отступ уровня, px', numberInput(explorer.indent, 6, 32, 2, (value) => apply({ indent: value }))),

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
      h('div', { class: 'field-hint' }, 'По строке на шаблон: `*.min.js`, `coverage`, `dist`. Поддерживаются `*`, `?` и `**`.'),

      h('div', { class: 'settings-divider' }),
      h('div', { class: 'field-label' }, 'Поведение'),
      switchRow('Открывать файл одним кликом', explorer.openOnSingleClick, (value) => apply({ openOnSingleClick: value })),
      h('div', { class: 'field-hint' }, 'Выключено — как в PyCharm: одинарный клик выделяет, двойной открывает.'),
      switchRow('Пометки git у файлов', explorer.gitDecorations, (value) => apply({ gitDecorations: value })),
      switchRow('Точка у папок с правками', explorer.folderChangeDot, (value) => apply({ folderChangeDot: value })),
      switchRow('Спрашивать перед удалением', explorer.confirmDelete, (value) => apply({ confirmDelete: value })),
    ];
  }

  function renderRun(): Child[] {
    const run: RunSettings = settings!.run;
    const apply = (values: Partial<RunSettings>): void => void patch({ run: values });

    const pythonPath = textInput(run.pythonPath, (value) => apply({ pythonPath: value }));
    pythonPath.placeholder = 'например, /usr/bin/python3 или .venv/bin/python';

    return [
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
      h('div', { class: 'field-hint' }, '«Автоматически» — по файлу блокировки в корне проекта: pnpm-lock.yaml, yarn.lock, bun.lockb, package-lock.json.'),
      field('Интерпретатор Python', pythonPath),
      h(
        'div',
        { class: 'field-hint' },
        'Пусто — берём окружение проекта (`.venv/bin/python`), а без него системный `python3`. Путь с пробелами подставляется в команду в кавычках.',
      ),
      switchRow('Сохранять файлы перед запуском', run.saveBeforeRun, (value) => apply({ saveBeforeRun: value })),
      h('div', { class: 'settings-divider' }),
      h('div', { class: 'field-label' }, 'Что можно запустить'),
      h(
        'div',
        { class: 'field-hint' },
        'Кнопка запуска появляется сама: Python и Node — файлом, если он запускаемый, и всегда — задачами из `scripts` в package.json. Горячие клавиши: Ctrl+F5 — запустить, Shift+F10 — выбрать.',
      ),
    ];
  }

  function renderAppearance(): Child[] {
    return [
      field(
        'Тема',
        selectInput(THEME_OPTIONS.map((item) => ({ value: item.value, label: item.label })), settings!.appearance.theme, (value) => {
          void deps.theme.set(value as ThemeChoice);
        }),
      ),
      h('div', { class: 'field-hint' }, '«Как в системе» переключает палитру вслед за схемой рабочего стола.'),
    ];
  }

  function renderLsp(): Child[] {
    const lsp = settings!.lsp;

    const servers = h('textarea', { class: 'field-input', rows: 8, spellcheck: false });
    servers.value = JSON.stringify(lsp.servers, null, 2);
    servers.addEventListener('change', () => {
      try {
        const parsed = JSON.parse(servers.value) as unknown;
        if (!Array.isArray(parsed)) throw new Error('ожидался массив');
        void patch({ lsp: { servers: parsed as LspServerConfig[] } }, true);
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
          if (found.length === 0) {
            showToast('Языковые серверы в PATH не найдены', 'error');
            return;
          }
          servers.value = JSON.stringify(found, null, 2);
          void patch({ lsp: { servers: found, enabled: true } }, true);
          showToast(`Найдено серверов: ${found.length}`);
        })
        .catch((error) => showToast(error instanceof Error ? error.message : String(error), 'error'))
        .finally(() => {
          detectButton.disabled = false;
        });
    });

    return [
      switchRow('Запускать языковые серверы', lsp.enabled, (value) => void patch({ lsp: { enabled: value } }, true)),
      h(
        'div',
        { class: 'field-hint' },
        'Сервер поднимается при первом открытии файла его языка и живёт до выхода из приложения. ' +
          'Его пометки показываются в редакторе рядом с собственными.',
      ),
      field('Серверы (JSON)', servers),
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

  function render(): void {
    if (settings === null) return;

    clear(nav);
    for (const item of SECTIONS) {
      const button = h(
        'button',
        {
          class: `modal-nav-item${item.id === section ? ' is-active' : ''}`,
          type: 'button',
          onClick: () => {
            section = item.id;
            render();
          },
        },
        svgIcon(item.icon, 14),
        h('span', {}, item.title),
      );
      nav.appendChild(button);
    }

    clear(pane);
    const content =
      section === 'ai'
        ? renderAi()
        : section === 'editor'
          ? renderEditor()
          : section === 'explorer'
            ? renderExplorer()
            : section === 'run'
              ? renderRun()
              : section === 'appearance'
                ? renderAppearance()
                : section === 'lsp'
                  ? renderLsp()
                  : renderProject();
    append(pane, content);
    pane.scrollTop = 0;
    title.textContent = `Настройки · ${SECTIONS.find((item) => item.id === section)?.title ?? ''}`;
  }

  return { element, open, close, applySettings };
}
