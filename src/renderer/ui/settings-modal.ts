import type {
  EditorSettings,
  ExplorerSettings,
  GitSettings,
  LspServerConfig,
  ReasoningEffort,
  RecentProject,
  RunSettings,
  Settings,
  SettingsPatch,
} from '../../shared/api';
import type { AiProviderPatch, AiProviderView, McpServerTools } from '../../shared/api';
import type { McpServerConfig } from '../../shared/mcp';
import { formatBalance } from '../../shared/balance';
import {
  findProviderPreset,
  offeredProviderPresets,
  providerConfigError,
  providerConfigFields,
  type ProviderConfigValues,
  type ProviderPreset,
} from '../../shared/providers';

/** Сводка о подключении: состояние видно, не открывая окно. */
function connectionSummary(provider: AiProviderView | undefined, activeModel: string | undefined): string {
  if (!provider) return 'не выбрано';
  const key = provider.hasApiKey ? 'ключ сохранён' : 'ключа нет';
  return `${key} · ${activeModel ?? provider.defaultModel ?? 'модель не выбрана'}`;
}

/**
 * Пресет для уже сохранённого провайдера: у своего подключения записи в списке может
 * не быть (идентификатор правили руками), поэтому берём его же данные — окно должно
 * открываться на любое подключение, а не только на известное.
 */
function presetOf(provider: AiProviderView): ProviderPreset {
  const known = findProviderPreset(provider.id);
  if (known) return known;
  return {
    id: provider.id,
    label: provider.label,
    baseUrl: provider.baseUrl,
    needsKey: provider.hasApiKey !== false,
    models: [...provider.models],
    defaultModel: provider.defaultModel ?? provider.models[0] ?? '',
    hint: 'Своё подключение: адрес, протокол и модели задаются вручную.',
  };
}
import { AUTO_SAVE_LABELS, AUTO_SAVE_MODES, normalizeAutoSaveMode } from '../../shared/auto-save';
import { CURSOR_STYLES, CURSOR_STYLE_LABELS, MAX_LINE_HEIGHT, normalizeCursorStyle } from '../../shared/cursor-style';
import { serializeThemeFile } from '../../shared/theme-file';
import { normalizeRulers, rulersToText } from '../../shared/rulers';
import { PULL_MODES, pullModeLabel } from '../../shared/git-pull';
import { uiScaleOptions } from '../../shared/ui-scale';
import type { WebSearchProvider } from '../../shared/web-search';
import { PYTHON_LSP_PACKAGES, lspLanguagesForKind } from '../../shared/lsp-presets';
import type { CommandRegistry } from '../core/commands';
import { menuAccelerators } from '../../shared/app-menu';
import {
  bindingConflicts,
  isMenuBinding,
  menuBindingId,
  menuCommandOf,
  type BindingLike,
} from '../../shared/keybindings';
import { DEFAULT_KEYBINDINGS } from '../core/default-keybindings';
import { comboFromEvent, isModifierKey } from '../core/keybindings';
import type { RpcClient } from '../core/rpc';
import { themeTemplate } from '../core/theme';
import { type Child, append, clear, h, svgIcon } from './dom';
import { createModal } from './modal';
import { createSelect } from './select';
import { showToast } from './toast';

export interface SettingsModalDeps {
  rpc: RpcClient;
  commands: CommandRegistry;
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
  /**
   * Перечитать настройки и показать окно. `sectionId` — сразу открыть нужный
   * раздел: по нему ведёт подсказка («серверы выключены»). Без него открывается
   * тот раздел, где человек был в прошлый раз.
   */
  open(sectionId?: SectionId): Promise<void>;
  close(): void;
  /** Текущее состояние из main (push `settings:changed`). */
  applySettings(settings: Settings): void;
}

export type SectionId =
  | 'ai'
  | 'editor'
  | 'keybindings'
  | 'explorer'
  | 'run'
  | 'git'
  | 'appearance'
  | 'project'
  | 'lsp'
  | 'mcp';

const SECTIONS: ReadonlyArray<{
  id: SectionId;
  title: string;
  icon: 'sparkle' | 'file' | 'sun' | 'panel' | 'folder' | 'play' | 'command' | 'branch';
}> = [
  { id: 'ai', title: 'AI', icon: 'sparkle' },
  { id: 'editor', title: 'Редактор', icon: 'file' },
  { id: 'keybindings', title: 'Сочетания клавиш', icon: 'command' },
  { id: 'explorer', title: 'Проводник', icon: 'folder' },
  { id: 'run', title: 'Запуск', icon: 'play' },
  { id: 'git', title: 'Git', icon: 'branch' },
  { id: 'appearance', title: 'Внешний вид', icon: 'sun' },
  { id: 'lsp', title: 'Языки (LSP)', icon: 'command' },
  { id: 'mcp', title: 'Внешние инструменты (MCP)', icon: 'sparkle' },
  { id: 'project', title: 'Проект', icon: 'panel' },
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

  const modal = createModal({
    className: 'settings-modal',
    title: 'Настройки',
    headerIcon: 'settings',
    footer: h(
      'footer',
      { class: 'modal-footer' },
      h(
        'button',
        {
          class: 'btn',
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
    // Esc в поиске сначала снимает запрос: закрывать окно, теряя набранное,
    // человек не просил. Поиск пуст — закрываем, как раньше.
    onEscape: () => {
      if (!query) return false;
      query = '';
      search.value = '';
      render();
      return true;
    },
  });
  modal.body.append(h('div', { class: 'modal-nav-column' }, search, nav), pane);

  /* ── инфраструктура окна ───────────────────────────────────────────────── */

  function close(): void {
    modal.close();
  }

  async function open(sectionId?: SectionId): Promise<void> {
    // Раздел — до первой отрисовки: `render` ниже берёт текущее значение.
    if (sectionId) section = sectionId;
    modal.open();

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
        // У инструмента за потолком помечаем, что модели он не достанется: иначе
        // список выглядел бы полным, а часть описаний молча не уходила бы.
        const names = server.tools
          .map((tool) => {
            const notes = [
              tool.readOnly ? '' : 'спросит подтверждение',
              tool.offered ? '' : 'за потолком — модели не предлагается',
            ]
              .filter(Boolean)
              .join(', ');
            return notes ? `${tool.name} (${notes})` : tool.name;
          })
          .join(', ');
        const hidden = server.tools.filter((tool) => !tool.offered).length;
        if (hidden === 0) return `${server.id}: инструментов ${server.tools.length} — ${names}`;
        return `${server.id}: инструментов ${server.tools.length}, модели пойдёт ${server.tools.length - hidden} — ${names}`;
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
    providerSelect.onChange((value) => void patch({ ai: { activeProviderId: value } }, true));

    // Добавление — селект: выбор провайдера открывает окно его подключения, потому
    // что настройки у всех разные (ключ, адрес, протокол, модели). Список — из
    // `OFFERED_PROVIDER_IDS` (shared/providers.ts): новый провайдер — одна строка там.
    const offered = offeredProviderPresets();
    const addSelect = createSelect({ title: 'Добавить провайдера', placeholder: 'Выберите провайдера…' });
    addSelect.setOptions(
      offered.map((item) => ({
        value: item.id,
        label: item.label,
        hint: ai.providers.some((existing) => existing.id === item.id) ? 'добавлен' : item.hint,
      })),
    );
    // Селект здесь — действие, а не текущее значение: `setOptions` сам ставит первую
    // опцию, и без сброса селект показывал бы «DeepSeek», а клик по этому пункту
    // ничего бы не делал — значение уже совпало с текущим.
    addSelect.setValue('');
    addSelect.setDisabled(offered.length === 0);
    addSelect.onChange((value) => {
      // Селект здесь — действие «подключить», а не текущее значение: после выбора
      // возвращаем подсказку, иначе второй выбор того же провайдера не сработает.
      addSelect.setValue('');
      const preset = findProviderPreset(value);
      if (preset) openProviderConfig(preset);
    });
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

    // Провайдер правится в своём окне, а не в панели: у локального сервера нет ключа,
    // у «Другого» важен протокол, у облачного — модель. Общий набор полей в панели
    // спрашивал бы лишнее и молчал бы о том, что этому провайдеру всё же нужно.
    const configButton = h(
      'button',
      {
        class: 'btn btn-small',
        type: 'button',
        disabled: !provider,
        onClick: () => {
          if (provider) openProviderConfig(presetOf(provider));
        },
      },
      'Настроить подключение…',
    );

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
      field('Добавить провайдера', h('div', { class: 'field-row' }, addSelect.element)),
      h('div', { class: 'settings-divider' }),
      // Ключ, адрес, протокол и модель — свойства подключения, а не ассистента:
      // у локального сервера ключа нет, у «Другого» важен протокол, список моделей
      // у каждого свой. Всё это — в окне подключения; панель только называет
      // текущее и даёт в него войти.
      h('div', { class: 'field-label' }, `Подключение: ${provider?.label ?? 'не выбрано'}`),
      h('div', { class: 'field-hint' }, connectionSummary(provider, ai.activeModel)),
      h('div', { class: 'field-row' }, configButton),
      preset ? h('div', { class: 'field-hint' }, preset.hint) : null,
      h('div', { class: 'settings-divider' }),
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
        'Проверять команды моделью перед подтверждением',
        ai.approvalReview,
        (value) => void patch({ ai: { approvalReview: value } }),
      ),
      h(
        'div',
        { class: 'field-hint' },
        'Ассистент запускает десяток безобидных команд за ответ — и на каждой карточке «Выполнить» ' +
          'начинают нажимать не читая. С этой проверкой безобидные команды (просмотр, поиск, git status, ' +
          'сборка, тесты) выполняются сами, а сомнительные по-прежнему спрашивают вас. ' +
          'Необратимые команды проверка не трогает никогда. Сомнительное и непонятное она тоже отдаёт вам — ' +
          'то есть лишний вопрос возможен, а пропущенное «разрешаю» нет. Каждая проверка — короткий запрос к модели.',
      ),
      field(
        'Модель для проверки команд',
        textInput(ai.reviewModel ?? '', (value) => void patch({ ai: { reviewModel: value } })),
      ),
      h(
        'div',
        { class: 'field-hint' },
        'Пусто — проверяет активная модель беседы. Здесь достаточно дешёвой: решение — одна строка ' +
          '«можно» или «спросить», а не разговор.',
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
        'Подсказка «допиши за меня» (inline)',
        ai.inlineCompletion.enabled,
        (value) => void patch({ ai: { inlineCompletion: { enabled: value } } }),
      ),
      h(
        'div',
        { class: 'field-hint' },
        'Модель серым текстом дописывает код в месте курсора, принять — Tab. Каждая подсказка — ' +
          'обращение к модели, поэтому выключено по умолчанию и спрашивается только после паузы в наборе.',
      ),
      field(
        'Задержка перед подсказкой (мс)',
        numberInput(
          ai.inlineCompletion.debounceMs,
          100,
          5000,
          50,
          (value) => void patch({ ai: { inlineCompletion: { debounceMs: value } } }),
        ),
      ),
      h('div', { class: 'settings-divider' }),
      switchRow(
        'Писать журнал прогонов в файл',
        ai.telemetry.enabled,
        (value) => void patch({ ai: { telemetry: { enabled: value } } }),
      ),
      h(
        'div',
        { class: 'field-hint' },
        'Каждый прогон агента ложится одной строкой в журнал: что ушло модели (инструкции, контекст ' +
          'проекта, состав инструментов), шаги с вызовами, время и итог. Нужен, чтобы разобрать «почему ' +
          'пошло не туда» уже после перезапуска — трасса под ответом живёт только до него. Ключи и ' +
          'пароли вычищаются при записи, файл лежит только на этом компьютере (папка данных приложения). ' +
          'Выключено по умолчанию: в записи есть ваши инструкции и ответы модели. Смотреть: «Журнал ' +
          'прогонов…» в палитре команд.',
      ),
      switchRow(
        'Веб-поиск (инструмент web, действие search)',
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
            { value: 'deepseek', label: 'Поиск DeepSeek (ключ подключения)' },
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
          : ai.webSearch.provider === 'deepseek'
            ? 'Пусто — адрес по умолчанию https://api.deepseek.com/v1/tools/search. ' +
                'Свой ключ не нужен: берётся ключ подключения DeepSeek.'
            : 'Пусто — адрес по умолчанию https://api.search.brave.com/res/v1/web/search.',
      ),
      webSearchKeyField,
      h('div', { class: 'settings-divider' }),
      switchRow(
        'Чтение страниц по ссылке (инструмент web, действие fetch)',
        ai.webFetch.enabled,
        (value) => void patch({ ai: { webFetch: { enabled: value } } }),
      ),
      h(
        'div',
        { class: 'field-hint' },
        'Даёт ассистенту открывать страницу из поисковой выдачи и читать её текстом — ' +
          'с заголовком и ссылками, по которым можно пойти дальше. Выключено по умолчанию: ' +
          'это ход наружу. Открывается только http и https, файлы (картинки, архивы, pdf) ' +
          'инструмент не читает, а адрес проверяется до запроса.',
      ),
      h('div', { class: 'settings-divider' }),
      switchRow(
        'Браузер (инструменты browser_*)',
        ai.browser.enabled,
        (value) => void patch({ ai: { browser: { enabled: value } } }),
      ),
      h(
        'div',
        { class: 'field-hint' },
        'Даёт ассистенту открывать страницы, нажимать кнопки и заполнять формы. Действия на ' +
          'странице спрашивают подтверждение, пока включён обычный режим доступа. Выключено ' +
          'по умолчанию: это ход наружу.',
      ),
      switchRow(
        'Во встроенном браузере',
        ai.browser.integrated,
        (value) => void patch({ ai: { browser: { integrated: value } } }),
      ),
      h(
        'div',
        { class: 'field-hint' },
        'Включено — агент работает вкладкой в редакторе, рядом с кодом, и видит ту же страницу, ' +
          'что и вы; открытые им страницы живут во временной сессии и ваших входов не видят. ' +
          'Выключено — отдельный Chromium: нужен, когда страницу надо проверить именно в вашем ' +
          'браузере, а не в движке IDE.',
      ),
      field(
        'Путь к браузеру',
        textInput(ai.browser.executable, (value) => void patch({ ai: { browser: { executable: value } } })),
      ),
      h(
        'div',
        { class: 'field-hint' },
        'Для отдельного Chromium. Пусто — искать в PATH известные имена (google-chrome, chromium, ' +
          'brave-browser, msedge). Firefox не подойдёт: он говорит не на том протоколе, которым ' +
          'управляет IDE.',
      ),
      switchRow('Без окна', ai.browser.headless, (value) => void patch({ ai: { browser: { headless: value } } })),
      h(
        'div',
        { class: 'field-hint' },
        'Для отдельного Chromium. С окном работу агента видно, но браузер всплывает поверх ' +
          'редактора. Без окна — тихо и годится на машинах без экрана.',
      ),
      h('div', { class: 'settings-divider' }),
      switchRow(
        'Песочница (команды в контейнере)',
        ai.sandbox.enabled,
        (value) => void patch({ ai: { sandbox: { enabled: value } } }),
      ),
      h(
        'div',
        { class: 'field-hint' },
        'Команды и тесты агента выполняются не на вашей машине, а в контейнере: в него монтируется ' +
          'только папка проекта, а домашний каталог, ключи и переменные окружения остаются снаружи. ' +
          'Установленное внутри контейнера исчезает после запуска. Если движка (docker или podman) ' +
          'в PATH нет, команда не выполнится — на хост она не переключается.',
      ),
      field(
        'Образ',
        textInput(ai.sandbox.image, (value) => void patch({ ai: { sandbox: { image: value } } })),
      ),
      h(
        'div',
        { class: 'field-hint' },
        'В образе должны быть инструменты проекта. По умолчанию python:3.12-slim — годится для Python ' +
          'из коробки; для Node подойдёт node:22-bookworm, для смешанного проекта — свой образ.',
      ),
      field(
        'Рабочий каталог в контейнере',
        textInput(ai.sandbox.workdir, (value) => void patch({ ai: { sandbox: { workdir: value } } })),
      ),
      h('div', { class: 'field-hint' }, 'Куда монтируется папка проекта. Пустое или непонятное значение — /workspace.'),
      switchRow('Разрешить сеть', ai.sandbox.network, (value) => void patch({ ai: { sandbox: { network: value } } })),
      h(
        'div',
        { class: 'field-hint' },
        'Без сети контейнер не сможет скачать зависимости: команды установки будут падать. ' +
          'Выключите, если запускаете код, которому наружу ходить незачем.',
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
      field(
        'Сжимать беседу чаще (ходов)',
        numberInput(
          ai.compactEveryTurns,
          0,
          200,
          1,
          (value) => void patch({ ai: { compactEveryTurns: value } }),
        ),
      ),
      h(
        'div',
        { class: 'field-hint' },
        'Ход — ваш вопрос вместе с ответом агента. 0 — не сжимать по расписанию: беседа сжимается сама, ' +
          'когда кеш контекста перестаёт попадать (каждый следующий запрос идёт по полной цене) ' +
          'или когда контекст подходит к концу окна модели.',
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

  /**
   * Окно подключения провайдера: его открывает выбор в селекте «Добавить провайдера».
   * Поля — из пресета (`providerConfigFields`): у провайдеров они разные (локальному
   * серверу ключ не нужен, «Другому» важен протокол), поэтому спрашиваем только то,
   * что этот провайдер требует. Окно только собирает значения — запись идёт тем же
   * `patch`, что и из панели.
   */
  function openProviderConfig(preset: ProviderPreset): void {
    if (settings === null) return;
    const existing = settings.ai.providers.find((item) => item.id === preset.id);
    const fields = providerConfigFields(preset);

    const plainInput = (value: string, placeholder = ''): HTMLInputElement => {
      const input = h('input', { class: 'field-input', type: 'text', spellcheck: false, placeholder });
      input.value = value;
      return input;
    };

    const labelField = plainInput(existing?.label ?? preset.label);
    const baseUrlField = plainInput(existing?.baseUrl ?? preset.baseUrl, 'https://…');
    const keyField = h('input', {
      class: 'field-input',
      type: 'password',
      spellcheck: false,
      placeholder: existing?.hasApiKey ? 'ключ сохранён — пустое поле его не меняет' : 'вставьте ключ',
    });

    // Ключ убирается здесь же: это свойство подключения, а не ассистента.
    const clearKeyButton = existing?.hasApiKey
      ? h('button', { class: 'btn btn-small', type: 'button', onClick: () => void clearKey() }, 'Убрать ключ')
      : null;

    async function clearKey(): Promise<void> {
      if (!existing) return;
      settings = await deps.rpc.request('ai.clearApiKey', { providerId: existing.id });
      keyField.placeholder = 'ключ удалён — вставьте новый, чтобы задать';
      if (clearKeyButton) clearKeyButton.disabled = true;
      status.textContent = 'Ключ удалён.';
    }

    const startModels = existing && existing.models.length > 0 ? existing.models : preset.models;
    const modelSelect = createSelect({ title: 'Модель', placeholder: 'выберите модель' });
    modelSelect.setOptions(startModels.map((model) => ({ value: model, label: model })));
    modelSelect.setValue(existing?.defaultModel ?? preset.defaultModel);

    const protocolSelect = createSelect({ title: 'Протокол' });
    protocolSelect.setOptions([
      { value: 'openai', label: 'OpenAI-совместимый' },
      { value: 'anthropic', label: 'Anthropic' },
    ]);
    protocolSelect.setValue(existing?.protocol ?? preset.protocol ?? 'openai');

    // Список моделей может прийти пустым (шлюз без `/models`, старая сборка), а работать
    // надо. Поле рядом — запасной вход; выбор в списке его очищает, чтобы не осталось
    // двух разных ответов на один вопрос.
    const manualModel = plainInput(
      existing?.defaultModel && !startModels.includes(existing.defaultModel) ? existing.defaultModel : '',
      'например, deepseek-flash',
    );
    modelSelect.onChange(() => {
      manualModel.value = '';
    });

    // Метка пользователя: провайдер считает по ней кеш контекста и лимиты, и без
    // неё двое за одной машиной делят их между собой.
    const userIdField = plainInput(existing?.userId ?? '', 'необязательно: имя или id пользователя');
    // Строгая схема аргументов: провайдер обязан вернуть ровно эти поля.
    const strictInput = h('input', { class: 'switch-input', type: 'checkbox' });
    strictInput.checked = existing?.strictTools === true;

    const status = h('div', { class: 'field-hint' }, preset.hint);

    const read = (): ProviderConfigValues => ({
      label: labelField.value.trim(),
      baseUrl: baseUrlField.value.trim(),
      apiKey: keyField.value.trim(),
      model: manualModel.value.trim() || modelSelect.value,
      protocol: protocolSelect.value === 'anthropic' ? 'anthropic' : 'openai',
      userId: userIdField.value.trim(),
      strictTools: strictInput.checked,
    });

    const checkButton = h('button', { class: 'btn', type: 'button' }, 'Проверить подключение');
    checkButton.addEventListener('click', () => {
      const current = read();
      const complaint = providerConfigError(preset, current);
      if (complaint !== null) {
        status.textContent = complaint;
        return;
      }
      checkButton.disabled = true;
      status.textContent = 'Проверяем подключение…';
      void deps.rpc
        .request('ai.test', {
          baseUrl: current.baseUrl,
          apiKey: current.apiKey || undefined,
          providerId: preset.id,
        })
        .then((result) => {
          // Баланс показываем там же, где результат проверки: это ответ на вопрос
          // «всё ли в порядке с подключением», а не отдельная страница.
          const balance = result.balance ? ` · ${formatBalance(result.balance)}` : '';
          status.textContent = result.ok
            ? `${result.message} · моделей: ${result.models.length}${balance}`
            : result.message;
          // Сервер сам перечислил модели — берём их, а не список из пресета:
          // человек должен выбирать из настоящих, а не набирать по памяти.
          if (result.ok && result.models.length > 0) {
            modelSelect.setOptions(result.models.map((model) => ({ value: model, label: model })));
            const first = result.models[0];
            if (first !== undefined && !result.models.includes(modelSelect.value)) modelSelect.setValue(first);
          }
        })
        .catch((error: unknown) => {
          status.textContent = error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
          checkButton.disabled = false;
        });
    });

    // Параметры генерации — свои у каждого подключения, поэтому живут здесь, а не в
    // разделе AI: общий лимит ответа не годится сразу и локальной 8K-модели, и облачной.
    const aiNow = settings!.ai;
    const temperatureInput = numberInput(existing?.temperature ?? aiNow.temperature, 0, 2, 0.1, () => undefined);
    // 0 — «предел модели»: у DeepSeek это 384K, у локальной 8K — 8K. Одного числа
    // на всех не бывает, а 256 в минимуме запрещало бы самое честное значение.
    const maxTokensInput = numberInput(existing?.maxTokens ?? aiNow.maxTokens, 0, 1_000_000, 256, () => undefined);
    const effortSelect = createSelect({ title: 'Усилие размышления' });
    effortSelect.setOptions([
      { value: 'off', label: 'Без размышлений' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      // `max` есть только у части моделей (DeepSeek знает low/high/max):
      // остальным он до провода не доедет, см. `wireEffort`.
      { value: 'max', label: 'Max' },
    ]);
    effortSelect.setValue(existing?.reasoningEffort ?? aiNow.reasoningEffort ?? 'off');

    const view = createModal({
      className: 'provider-config-modal',
      title: `Подключение: ${preset.label}`,
      footer: h(
        'footer',
        { class: 'modal-footer' },
        checkButton,
        h('button', { class: 'btn', type: 'button', onClick: () => close() }, 'Отмена'),
        h('button', { class: 'btn btn-primary', type: 'button', onClick: () => void submit() }, 'Сохранить'),
      ),
    });

    function close(): void {
      view.close();
      view.element.remove();
    }

    async function submit(): Promise<void> {
      const current = read();
      const complaint = providerConfigError(preset, current);
      if (complaint !== null) {
        status.textContent = complaint;
        return;
      }

      // Список моделей в конфиге: прежние (или стартовые из пресета) плюс выбранная —
      // иначе селект модели в панели остался бы без выбранного значения.
      const list = existing && existing.models.length > 0 ? [...existing.models] : [...preset.models];
      if (current.model !== '' && !list.includes(current.model)) list.unshift(current.model);

      const provider: AiProviderPatch = {
        id: preset.id,
        label: current.label || preset.label,
        baseUrl: current.baseUrl,
        models: list,
        defaultModel: current.model,
      };
      if (fields.includes('protocol')) provider.protocol = current.protocol;
      // Параметры запроса — часть подключения: вместе с адресом и моделью.
      // Пустое поле и 0 значат одно — «предел модели»: такое значение не отправляем,
      // чтобы не передавать в main явный ноль, который читается как «ответа не будет».
      const temperatureValue = Number(temperatureInput.value);
      if (temperatureInput.value.trim() !== '' && Number.isFinite(temperatureValue)) {
        provider.temperature = temperatureValue;
      }
      const maxTokensValue = Number(maxTokensInput.value);
      if (maxTokensInput.value.trim() !== '' && Number.isFinite(maxTokensValue) && maxTokensValue > 0) {
        provider.maxTokens = maxTokensValue;
      }
      provider.reasoningEffort = effortSelect.value as ReasoningEffort;
      // Пустое поле — «метки нет», поэтому отправляем пустую строку: main по ней стирает.
      provider.userId = current.userId ?? '';
      provider.strictTools = current.strictTools === true;

      try {
        await patch({ ai: { provider } });
        if (current.apiKey !== '') {
          settings = await deps.rpc.request('ai.setApiKey', { providerId: preset.id, apiKey: current.apiKey });
        }
        await patch({ ai: { activeProviderId: preset.id } }, true);
        close();
        showToast(existing ? `«${provider.label}» обновлён` : `Добавлен провайдер «${provider.label}»`);
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error);
      }
    }

    const rows: (HTMLElement | null)[] = [
      fields.includes('label') ? field('Название', labelField) : null,
      fields.includes('baseUrl') ? field('Адрес API', baseUrlField) : null,
      fields.includes('apiKey')
        ? field('API-ключ', h('div', { class: 'field-row' }, keyField, clearKeyButton))
        : null,
      fields.includes('model') ? field('Модель', modelSelect.element) : null,
      fields.includes('model') ? field('Или id модели вручную', manualModel) : null,
      fields.includes('protocol') ? field('Протокол', protocolSelect.element) : null,
      h('div', { class: 'settings-divider' }),
      field('Метка пользователя', userIdField),
      h(
        'div',
        { class: 'field-hint' },
        'Уходит провайдеру как user_id: по нему разделяются кеш контекста и лимиты.',
      ),
      h(
        'div',
        { class: 'field field-between' },
        h('span', {}, 'Строгая схема аргументов'),
        h('label', { class: 'switch' }, strictInput, h('span', { class: 'switch-track' })),
      ),
      h(
        'div',
        { class: 'field-hint' },
        'Провайдер обязан вернуть аргументы инструментов строго по схеме. У DeepSeek это ' +
          'beta-функция: адрес сам станет /beta, а часть схем (`minLength`) там не поддерживается.',
      ),
      h('div', { class: 'settings-divider' }),
      field('Усилие размышления', effortSelect.element),
      field('Температура', temperatureInput),
      field('Максимум токенов ответа', maxTokensInput),
      h(
        'div',
        { class: 'field-hint' },
        'Отправляются только тем моделям, которые их принимают: temperature не уходит ' +
          'o-серии и моделям с фиксированным размышлением, усилие — только тем, кто его понимает. ' +
          'Максимум токенов 0 — «сколько даст модель» (у DeepSeek 384K, у локальной 8K — 8K).',
      ),
      status,
    ];
    view.body.append(...rows.filter((row): row is HTMLElement => row !== null));
    document.body.append(view.element);
    view.open();
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

    await patch({ ai: { removeProviderId: providerId } }, true);
  }

  function renderEditor(): Child[] {
    const editor: EditorSettings = settings!.editor;
    const editable = (values: Partial<EditorSettings>): void => void patch({ editor: values });
    const words = h('textarea', {
      class: 'field-input',
      rows: 4,
      spellcheck: false,
      placeholder: 'проектный\nтермин',
    });
    words.value = editor.spellWords.join('\n');
    words.addEventListener('change', () => {
      const list = words.value
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      editable({ spellWords: list });
    });
    return [
      h('div', { class: 'field-label' }, 'Шрифт'),
      field(
        'Размер шрифта',
        numberInput(editor.fontSize, 8, 32, 1, (value) => editable({ fontSize: value })),
      ),
      field(
        'Высота строки, px (0 — по шрифту)',
        numberInput(editor.lineHeight, 0, MAX_LINE_HEIGHT, 1, (value) => editable({ lineHeight: value })),
      ),
      h('div', { class: 'settings-divider' }),
      h('div', { class: 'field-label' }, 'Отступы'),
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

      h('div', { class: 'settings-divider' }),
      h('div', { class: 'field-label' }, 'Направляющие'),
      field(
        'Столбцы через запятую',
        textInput(rulersToText(editor.rulers), (value) => editable({ rulers: normalizeRulers(value) })),
      ),
      h(
        'div',
        { class: 'field-hint' },
        'Вертикальные черты на этих столбцах — ориентир длины строки. Пустое поле убирает направляющие.',
      ),

      h('div', { class: 'settings-divider' }),
      h('div', { class: 'field-label' }, 'Вид'),
      field(
        'Невидимые знаки',
        selectInput(
          [
            { value: 'none', label: 'Скрыть' },
            { value: 'trailing', label: 'Только в конце строки' },
            { value: 'all', label: 'Все' },
          ],
          editor.renderWhitespace,
          (value) => editable({ renderWhitespace: value as EditorSettings['renderWhitespace'] }),
        ),
      ),
      h(
        'div',
        { class: 'field-hint' },
        'Пробелы показываются точками по центру, табуляции — стрелкой. «Только в конце строки» ' +
          'помогает увидеть хвосты, которые убирает сохранение.',
      ),
      switchRow('Миникарта', editor.minimap, (value) => editable({ minimap: value })),
      switchRow('Перенос длинных строк', editor.wordWrap, (value) => editable({ wordWrap: value })),
      switchRow('Плавная прокрутка', editor.smoothScroll, (value) => editable({ smoothScroll: value })),
      switchRow('Vim-режим', editor.vimMode, (value) => editable({ vimMode: value })),
      h(
        'div',
        { class: 'field-hint' },
        'Модальное управление клавишами, как в Vim: нормальный и визуальный режимы, операторы (d/c/y), счётчики. Выход из вставки — Escape.',
      ),
      switchRow('Emacs-режим', editor.emacsMode, (value) => editable({ emacsMode: value })),
      h(
        'div',
        { class: 'field-hint' },
        'Сочетания Ctrl/Alt, как в Emacs: Ctrl+F/B/N/P — движение, Ctrl+A/E — края строки, Ctrl+K/U/Y — убить и вставить, Ctrl+Space — метка. Обычный ввод при этом не меняется.',
      ),
      h(
        'div',
        { class: 'field-hint' },
        'Прыжок курсора (Ctrl+G, переход к строке, F8) уводит текст коротким разгоном, а не скачком. По клику и при наборе прокрутка остаётся мгновенной.',
      ),
      switchRow('Лигатуры шрифта', editor.fontLigatures, (value) => editable({ fontLigatures: value })),
      switchRow('Emmet (раскрытие сокращений по Tab)', editor.emmet, (value) => editable({ emmet: value })),
      h(
        'div',
        { class: 'field-hint' },
        'В разметке и стилях Tab раскрывает сокращение: `ul>li*3` → список, `m10` → `margin: 10px;`.',
      ),
      h(
        'div',
        { class: 'field-hint' },
        'Сжатый вид всего файла у правого края: по нему видно форму файла и куда перейти кликом.',
      ),
      h(
        'div',
        { class: 'field-hint' },
        'Лигатуры рисуют `=>`, `!=`, `->` одним знаком. Нужен шрифт с лигатурами — иначе ничего не изменится.',
      ),

      h('div', { class: 'settings-divider' }),
      h('div', { class: 'field-label' }, 'Каретка'),
      field(
        'Форма',
        selectInput(
          CURSOR_STYLES.map((style) => ({ value: style, label: CURSOR_STYLE_LABELS[style] })),
          editor.cursorStyle,
          (value) => editable({ cursorStyle: normalizeCursorStyle(value) }),
        ),
      ),
      switchRow('Мигание каретки', editor.cursorBlink, (value) => editable({ cursorBlink: value })),
      h(
        'div',
        { class: 'field-hint' },
        'Блок — каретка на всю клетку знака, подчёркивание — тонкая черта под ним. Выключенное мигание спокойнее при долгом чтении.',
      ),

      h('div', { class: 'settings-divider' }),
      h('div', { class: 'field-label' }, 'Орфография'),
      switchRow('Проверка орфографии', editor.spellcheck, (value) => editable({ spellcheck: value })),
      h(
        'div',
        { class: 'field-hint' },
        'Под словами не из словаря появляется зелёная волна. Словарь берётся из системы ' +
          '(aspell, hunspell, LibreOffice); путь можно задать переменной окружения CHUI_DICTIONARY.',
      ),
      field('Свои слова', words),
      h(
        'div',
        { class: 'field-hint' },
        'Слова по одному в строке — их прибавка к системному словарю. Быстрее всего добавить ' +
          'слово правым кликом по нему: «Добавить в словарь».',
      ),

      h('div', { class: 'settings-divider' }),
      h('div', { class: 'field-label' }, 'Сохранение'),
      switchRow('Форматировать при сохранении', editor.formatOnSave, (value) => editable({ formatOnSave: value })),
      switchRow('Форматировать при вставке', editor.formatOnPaste, (value) => editable({ formatOnPaste: value })),
      h(
        'div',
        { class: 'field-hint' },
        'Вставленный кусок приводит в порядок языковой сервер — он правит только вставленное, ' +
          'а не файл целиком. Инструмент проекта так не умеет, поэтому без сервера настройка молчит.',
      ),
      field(
        'Автосохранение',
        selectInput(
          AUTO_SAVE_MODES.map((mode) => ({ value: mode, label: AUTO_SAVE_LABELS[mode] })),
          editor.autoSave,
          (value) => editable({ autoSave: normalizeAutoSaveMode(value) }),
        ),
      ),
      field(
        'Пауза после правки, мс',
        numberInput(editor.autoSaveDelayMs, 200, 60_000, 100, (value) => editable({ autoSaveDelayMs: value })),
      ),
      h(
        'div',
        { class: 'field-hint' },
        'Пока автосохранение выключено, файл пишет человек (Ctrl+S). «Через паузу» пишет сам, ' +
          'когда набор остановился; «при переходе» — когда открываешь другой файл; «при потере фокуса» — ' +
          'когда окно уходит в фон. Правки при сохранении и форматирование применяются так же, как при Ctrl+S.',
      ),
      switchRow('Убирать пробелы в конце строк', editor.trimTrailingWhitespace, (value) =>
        editable({ trimTrailingWhitespace: value }),
      ),
      switchRow('Перевод строки в конце файла', editor.insertFinalNewline, (value) =>
        editable({ insertFinalNewline: value }),
      ),
      h(
        'div',
        { class: 'field-hint' },
        'Подрезка хвостов и завершающий перевод применяются при сохранении файла — и сразу видны в редакторе.',
      ),
      h(
        'div',
        { class: 'field-hint' },
        'Свои сниппеты (шаблоны кода) задаются в settings.json — поле `editor.snippets`: ' +
          'массив из `{ prefix, body, description?, languages? }`. К ним добавляется небольшой набор по умолчанию.',
      ),
    ];
  }

  /**
   * Редактор горячих клавиш. В одном списке два рода сочетаний: свои у команд,
   * которые перехватывает renderer (`core/default-keybindings.ts`), и клавиши
   * пунктов меню (их держит Electron — строка «клавиша меню», хранится с приставкой
   * `menu:` и перестраивает меню в main). Сочетание набирается прямо в поле: клик по
   * полю — и нажмите нужные клавиши. Backspace снимает сочетание, Esc — отмена набора.
   * Поиск прячет строки на месте, не перерисовывая раздел.
   */
  function renderKeybindings(): Child[] {
    // Два рода клавиш в одном списке: `command` — сочетание renderer, `menu:command` —
    // клавиша пункта меню (её держит Electron). Оба хранятся в одних переопределениях.
    const saved = new Map(settings!.keybindings.overrides.map((item) => [item.command, item.combo]));
    const menuKeys = menuAccelerators();
    const rendererDefaults = new Map(DEFAULT_KEYBINDINGS.map((binding) => [binding.command, binding.combo]));
    // Клавиши меню, заданные заново: их команда может и не иметь встроенной клавиши.
    const menuOverrides = new Set(
      [...saved.keys()].filter((key) => isMenuBinding(key)).map((key) => menuCommandOf(key)),
    );

    const write = (key: string, combo: string, fallback: string): void => {
      const next = new Map(saved);
      // Вернули исходное (или сняли вовсе) — не храним лишнего: переопределение только
      // затем и нужно, чтобы отличаться от значения по умолчанию.
      if (!combo || combo === fallback) next.delete(key);
      else next.set(key, combo);
      void patch({
        keybindings: { overrides: [...next.entries()].map(([id, value]) => ({ command: id, combo: value })) },
      });
    };

    // Кандидаты — все команды реестра: так сочетание можно задать и той команде, у
    // которой его прежде не было. Плюс те, что встречаются в переопределениях (команду
    // могли убрать из реестра, а настройка осталась — её надо показать и снять).
    const commands = new Map<string, { category: string; title: string; keywords: string }>();
    for (const descriptor of deps.commands.list()) {
      commands.set(descriptor.id, {
        category: descriptor.category || 'Прочее',
        title: descriptor.title || descriptor.id,
        keywords: (descriptor.keywords ?? []).join(' '),
      });
    }
    for (const key of saved.keys()) {
      const command = menuCommandOf(key);
      if (!commands.has(command)) commands.set(command, { category: 'Прочее', title: command, keywords: '' });
    }

    const entries: Array<{ element: HTMLElement; search: string; header: boolean; hasKey: boolean }> = [];
    const bindings: BindingLike[] = [];
    let category = '';
    // Порядок — по категории, затем по названию: так заголовок группы стоит один раз,
    // а внутри группы пункты идут по алфавиту, а не вперемешку с чужими.
    const ordered = [...commands.entries()].sort(
      ([idA, a], [idB, b]) =>
        a.category.localeCompare(b.category, 'ru') || a.title.localeCompare(b.title, 'ru') || idA.localeCompare(idB),
    );

    for (const [command, info] of ordered) {
      if (info.category !== category) {
        category = info.category;
        entries.push({
          element: h('div', { class: 'field-label' }, category),
          search: '',
          header: true,
          hasKey: false,
        });
      }
      const searchText = `${command} ${info.title} ${info.category} ${info.keywords}`.toLowerCase();
      // Сочетание renderer: есть у команд с сочетанием по умолчанию либо там, где
      // человек его задал сам. У прочих поле пустое — покажется, если команду искать.
      const rendererKey = rendererDefaults.has(command) || saved.has(command);
      {
        const fallback = rendererDefaults.get(command) ?? '';
        const current = saved.has(command) ? saved.get(command)! : fallback;
        if (current) bindings.push({ combo: current, command });
        const row = h(
          'div',
          { class: 'field field-between' },
          h('span', {}, info.title),
          comboControl(current, (combo) => write(command, combo, fallback)),
        );
        entries.push({ element: row, search: searchText, header: false, hasKey: rendererKey });
      }
      // Клавиша пункта меню: отдельной строкой, потому что её держит система. Строка
      // есть и у пункта без встроенной клавиши — если человек задал её сам.
      if (menuKeys.has(command) || menuOverrides.has(command)) {
        const key = menuBindingId(command);
        const fallback = menuKeys.get(command) ?? '';
        const current = saved.has(key) ? saved.get(key)! : fallback;
        bindings.push({ combo: current, command: key });
        const row = h(
          'div',
          { class: 'field field-between' },
          h('span', { class: 'field-sub' }, `${info.title} — клавиша меню`),
          comboControl(current, (combo) => write(key, combo, fallback)),
        );
        entries.push({ element: row, search: `${searchText} клавиша меню`, header: false, hasKey: true });
      }
    }

    const filter = h('input', {
      class: 'field-input',
      type: 'search',
      spellcheck: false,
      placeholder: 'Найти команду…',
    });
    // Фильтр — не перерисовка: прячем строки на месте, иначе поле теряло бы фокус на
    // каждой букве. По умолчанию видны команды с клавишами; поиск открывает и прочие,
    // чтобы можно было назначить сочетание там, где его не было.
    const applyFilter = (): void => {
      const needle = filter.value.trim().toLowerCase();
      const visible = entries.map((entry) => {
        if (entry.header) return false;
        const match = !needle || entry.search.includes(needle);
        return match && (entry.hasKey || needle.length > 0);
      });
      // Заголовок группы виден, пока виден хоть один её пункт.
      for (let index = 0; index < entries.length; index += 1) {
        if (!entries[index]!.header) continue;
        let any = false;
        for (let next = index + 1; next < entries.length && !entries[next]!.header; next += 1) {
          if (visible[next]) {
            any = true;
            break;
          }
        }
        visible[index] = any;
      }
      entries.forEach((entry, index) => {
        entry.element.hidden = !visible[index];
      });
    };
    filter.addEventListener('input', applyFilter);
    applyFilter();

    // Что с чем столкнулось: одно сочетание у нескольких команд — почти всегда описка.
    const clashes = bindingConflicts(bindings);

    const head: Child[] = [
      filter,
      h(
        'div',
        { class: 'field-hint' },
        'Кликните поле и нажмите сочетание. Backspace снимает сочетание, Esc — отмена набора. ' +
          'Строка команды — сочетание самого редактора, строка «клавиша меню» — клавиша пункта меню ' +
          '(её меняет система). Поиск открывает и команды без сочетания — им можно задать новое.',
      ),
    ];
    if (clashes.length > 0) {
      head.push(
        h(
          'div',
          { class: 'field-hint' },
          `Одно сочетание у нескольких команд: ${clashes.map((item) => item.combo).join(', ')}. ` +
            'Сработает первое, остальным стоит задать другое.',
        ),
      );
    }
    return [...head, ...entries.map((entry) => entry.element)];
  }

  /** Поле сочетания: читает нажатую комбинацию и само ничего не печатает. */
  function comboControl(value: string, onChange: (next: string) => void): HTMLInputElement {
    const input = h('input', {
      class: 'field-input',
      type: 'text',
      spellcheck: false,
      readonly: true,
      placeholder: 'Нажмите сочетание',
    });
    input.value = value;
    input.addEventListener('keydown', (event) => {
      event.preventDefault();
      if (event.key === 'Backspace' || event.key === 'Delete') {
        input.value = '';
        onChange('');
        return;
      }
      if (event.key === 'Escape') {
        input.blur();
        return;
      }
      // Одно нажатие модификатора сочетанием не считается — ждём ещё знак.
      if (isModifierKey(event.key)) return;
      const combo = comboFromEvent(event);
      input.value = combo;
      onChange(combo);
    });
    return input;
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

    const nesting = h('textarea', {
      class: 'field-input',
      rows: 3,
      spellcheck: false,
      placeholder: '*.tsx: *.test.tsx, *.module.css',
    });
    nesting.value = explorer.nestingRules.join('\n');
    nesting.addEventListener('change', () => {
      const lines = nesting.value
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      apply({ nestingRules: lines });
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
      switchRow('Группировать файлы по назначению', explorer.groupByType, (value) => apply({ groupByType: value })),
      h(
        'div',
        { class: 'field-hint' },
        'Файлы собираются под полками «Тесты», «Стили», «Документация» и другими; папки остаются сверху.',
      ),
      switchRow('Пакеты монорепо отдельными строками', explorer.groupByPackage, (value) =>
        apply({ groupByPackage: value }),
      ),
      h(
        'div',
        { class: 'field-hint' },
        'В монорепо видно пакеты верхнего уровня; промежуточный каталог `packages` скрыт.',
      ),
      field(
        'Сортировка',
        selectInput(
          [
            { value: 'name', label: 'По имени' },
            { value: 'type', label: 'По типу файла' },
            { value: 'modified', label: 'По времени изменения' },
            { value: 'git', label: 'По пометкам git' },
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
      switchRow('Свёртывать связанные файлы', explorer.fileNesting, (value) => apply({ fileNesting: value })),
      h(
        'div',
        { class: 'field-hint' },
        'Спутники (`Button.module.css`, `Button.test.tsx`) прячутся под родителя ' +
          '(`Button.tsx`). Со своими правилами вроде `*.py: test_*.py`.',
      ),
      field('Правила вложения', nesting),

      h('div', { class: 'settings-divider' }),
      h('div', { class: 'field-label' }, 'Поведение'),
      switchRow('Открывать файл одним кликом', explorer.openOnSingleClick, (value) =>
        apply({ openOnSingleClick: value }),
      ),
      h('div', { class: 'field-hint' }, 'Выключено: одинарный клик выделяет, двойной открывает.'),
      switchRow('Пометки git у файлов', explorer.gitDecorations, (value) => apply({ gitDecorations: value })),
      switchRow('Точка у папок с правками', explorer.folderChangeDot, (value) => apply({ folderChangeDot: value })),
      switchRow('Отмечать недавно изменённые', explorer.recentChanges, (value) => apply({ recentChanges: value })),
      field(
        'Окно свежести, ч',
        numberInput(explorer.recentWindowHours, 1, 720, 1, (value) => apply({ recentWindowHours: value })),
      ),
      h(
        'div',
        { class: 'field-hint' },
        'Файл, тронутый в пределах окна, получает точку свежести. Это про время правки, ' +
          'а не про состояние git: незакоммиченный файл недельной давности помечен им же.',
      ),
      switchRow('Приглушать игнорируемые git', explorer.dimIgnored, (value) => apply({ dimIgnored: value })),
      h(
        'div',
        { class: 'field-hint' },
        'Файлы из `.gitignore` (например, `node_modules`, `dist`) показываются приглушённо: ' +
          'их видно и можно открыть, но они не отвлекают.',
      ),
      switchRow('Спрашивать перед удалением', explorer.confirmDelete, (value) => apply({ confirmDelete: value })),
      switchRow('Править импорты при переименовании', explorer.updateImportsOnRename, (value) =>
        apply({ updateImportsOnRename: value }),
      ),
      h(
        'div',
        { class: 'field-hint' },
        'Переименовали файл или папку — относительные пути на него в коде проекта переводятся на новое имя. ' +
          'Работает для JS/TS, CSS и Python; выключено — файл переименуется, а ссылки останутся прежними.',
      ),
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

  /**
   * Тема из файла: JSON с частичным набором ролей. Одна кнопка импортирует
   * (main читает файл и проверяет его), вторая кладёт шаблон встроенной схемы —
   * из него удобно начать свою.
   */
  function renderThemeFileSection(): Child[] {
    const current = settings!.appearance.customTheme ?? null;

    const importButton = h('button', { class: 'btn btn-small', type: 'button' }, 'Импортировать…');
    importButton.addEventListener('click', async () => {
      try {
        const result = await deps.rpc.request('theme.import');
        settings = result.settings;
        render();
        if (result.name) showToast(`Тема «${result.name}» применена`);
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error), 'error');
      }
    });

    const exportButton = h('button', { class: 'btn btn-small', type: 'button' }, 'Сохранить шаблон…');
    exportButton.addEventListener('click', async () => {
      try {
        const contents = serializeThemeFile(themeTemplate());
        const result = await deps.rpc.request('theme.export', { contents, name: 'chui-theme.json' });
        if (result.path) showToast(`Шаблон сохранён: ${result.path}`);
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error), 'error');
      }
    });

    const actions = h('div', { class: 'field-actions' }, importButton, exportButton);

    if (current) {
      const clearButton = h('button', { class: 'btn btn-small', type: 'button' }, 'Убрать');
      clearButton.addEventListener('click', async () => {
        try {
          settings = await deps.rpc.request('theme.clear');
          render();
        } catch (error) {
          showToast(error instanceof Error ? error.message : String(error), 'error');
        }
      });
      actions.append(clearButton);
    }

    const hint = current
      ? `Активна тема «${current.name}». Она задаёт фон, текст, акценты и подсветку кода.`
      : 'JSON с частью ролей (фон, текст, акценты, подсветка кода). «Сохранить шаблон…» кладёт файл, из которого удобно начать свою тему.';

    return [
      h('div', { class: 'settings-divider' }),
      field('Тема из файла', actions),
      h('div', { class: 'field-hint' }, hint),
    ];
  }

  function renderGit(): Child[] {
    const git: GitSettings = settings!.git;
    const apply = (values: Partial<GitSettings>): void => void patch({ git: values });
    return [
      h('div', { class: 'field-label' }, 'Вливание изменений (pull)'),
      field(
        'Режим',
        selectInput(
          PULL_MODES.map((mode) => ({ value: mode, label: pullModeLabel(mode) })),
          git.pullMode,
          (value) => apply({ pullMode: value as GitSettings['pullMode'] }),
        ),
      ),
      h(
        'div',
        { class: 'field-hint' },
        'Слияние оставляет историю как есть, перебазирование переносит ваши коммиты на пришедшие ' +
          '(история линейная), «только перемотка» отказывается вливать, если ветки разошлись. ' +
          '«Как настроено в git» не подсказывает флагов — поведение задаёт ваш git. Разово влить ' +
          'перебазированием можно командой «Влить изменения (pull) с перебазированием».',
      ),
      h('div', { class: 'settings-divider' }),
      switchRow('Сохранять файлы перед коммитом', git.saveBeforeCommit, (value) => apply({ saveBeforeCommit: value })),
      h(
        'div',
        { class: 'field-hint' },
        'Коммит читает файлы на диске, а не то, что набрано в редакторе: с этой настройкой ' +
          'несохранённые файлы записываются перед коммитом. Иначе правки остались бы вне коммита, ' +
          'а вкладка — с пометкой «не сохранён».',
      ),
    ];
  }

  function renderAppearance(): Child[] {
    return [
      field(
        'Масштаб интерфейса',
        selectInput(
          uiScaleOptions(),
          String(settings!.appearance.uiScale),
          (value) => void patch({ appearance: { uiScale: Number(value) } }),
        ),
      ),
      h(
        'div',
        { class: 'field-hint' },
        'Крупнее или плотнее оболочка — панели, меню, дерево. Кегль кода настраивается отдельно ' +
          'в разделе «Редактор».',
      ),
      ...renderThemeFileSection(),
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
    const detect = async (): Promise<void> => {
      const found = await deps.rpc.request('lsp.detect');
      const relevant = found.filter(isOwn);
      if (relevant.length === 0) {
        showToast('Языковые серверы в PATH не найдены', 'error');
        return;
      }
      servers.value = JSON.stringify(relevant, null, 2);
      void patch({ lsp: { servers: [...foreign, ...relevant], enabled: true } }, true);
      showToast(`Найдено серверов: ${relevant.length}`);
    };

    const detectButton = h('button', { class: 'btn btn-small', type: 'button' }, 'Найти установленные');
    detectButton.addEventListener('click', () => {
      detectButton.disabled = true;
      void detect()
        .catch((error) => showToast(error instanceof Error ? error.message : String(error), 'error'))
        .finally(() => {
          detectButton.disabled = false;
        });
    });

    // Установка сервера в окружение проекта: серверу нужны пакеты проекта, а
    // системный питон их не видит. Ставим питоном проекта через `python.install` —
    // тем же путём, что зависимости импортов: с прогрессом и без терминала.
    // Кнопка только для Python: у Node сервер ставится пакетным менеджером.
    const isPythonProject = languages?.includes('python') ?? false;
    const installButton = h('button', { class: 'btn btn-small', type: 'button' }, 'Установить сервер (Python)');
    installButton.addEventListener('click', () => {
      installButton.disabled = true;
      showToast(`Ставлю: ${PYTHON_LSP_PACKAGES.join(', ')}…`);
      void deps.rpc
        .stream('python.install', { packages: [...PYTHON_LSP_PACKAGES], requirements: false }, () => undefined)
        .then(async (result) => {
          showToast(result.installed.length > 0 ? `Установлено: ${result.installed.join(', ')}` : 'Нечего ставить');
          await detect();
        })
        .catch((error) => showToast(error instanceof Error ? error.message : String(error), 'error'))
        .finally(() => {
          installButton.disabled = false;
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
          showToast('Серверы остановлены — поднимутся заново при следующем открытии проекта или файла');
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
      switchRow('Журнал обмена с серверами (отладка)', lsp.trace, (value) => void patch({ lsp: { trace: value } })),
      h(
        'div',
        { class: 'field-hint' },
        'Пишет все сообщения обмена с серверами в файл lsp-trace.log в папке пользовательских данных. ' +
          'Помогает понять, почему сервер молчит или отвечает пусто. Работает сразу, перезапуск не нужен.',
      ),
      switchRow('Журнал обмена с серверами (отладка)', lsp.trace, (value) => void patch({ lsp: { trace: value } })),
      h(
        'div',
        { class: 'field-hint' },
        'Пишет все сообщения обмена с серверами в файл lsp-trace.log в папке пользовательских данных. ' +
          'Помогает понять, почему сервер молчит или отвечает пусто. Работает сразу, перезапуск не нужен.',
      ),
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
          'rust-analyzer, gopls и другие). Серверы языков проекта IDE поднимает сама, как только ' +
          'проект открыт; тумблер «Запускать языковые серверы» выше останавливает их и запрещает запуск.',
      ),
      isPythonProject ? field('Установить сервер', installButton) : null,
      isPythonProject
        ? h(
            'div',
            { class: 'field-hint' },
            'Ставит python-lsp-server с линтерами (pyflakes, pycodestyle) в окружение проекта и сразу ' +
              'подставляет найденное. Серверу нужно окружение проекта: без него он не увидит зависимости.',
          )
        : null,
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
    if (id === 'keybindings') return renderKeybindings();
    if (id === 'explorer') return renderExplorer();
    if (id === 'run') return renderRun();
    if (id === 'git') return renderGit();
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
    modal.title.textContent = needle
      ? `Настройки · поиск: ${query.trim()}`
      : `Настройки · ${SECTIONS.find((item) => item.id === section)?.title ?? ''}`;
  }

  return { element: modal.element, open, close, applySettings };
}
