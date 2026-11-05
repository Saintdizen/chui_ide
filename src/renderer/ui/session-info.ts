import type { ChatAttachment, ChatMessage, ChatUsage } from '../../shared/api';
import {
  contextUsage,
  estimateAttachmentTokens,
  estimateContextParts,
  estimateTextTokens,
  type ContextUsage,
} from '../../shared/context-fit';
import { AGENT_TOOLS } from '../../shared/tools';
import { type AppliedInstruction, appliedInstructionsLines } from '../../shared/instructions';
import { formatTokens } from '../../shared/usage';
import { clear, h, svgIcon } from './dom';
import { formatBalance, type AccountBalance } from '../../shared/balance';

/**
 * «Информация о сессии» — сколько контекста занято и из чего он состоит.
 *
 * Провайдер сообщает только общий размер запроса (`usage.prompt_tokens`).
 * Разбивку по частям он не отдаёт, поэтому она считается по символам и
 * масштабируется на реальный итог: пропорции честные, а сумма совпадает
 * с тем, что вернула модель. Пока ответа ещё не было, всё помечено «≈».
 */

export interface SessionInfoData {
  provider: string;
  model: string;
  history: readonly ChatMessage[];
  attachments: readonly ChatAttachment[];
  /** Системный промпт: он тоже часть запроса и занимает контекст. */
  systemPrompt: string;
  /**
   * Файлы правил проекта, которые main подмешал к промпту в прошлом ходе.
   * Здеся, а не в промпте: человек ищет «наши правила применились?», а видит
   * только общую строку инструкций.
   */
  instructions?: readonly AppliedInstruction[];
  /** Предлагаются ли модели описания инструментов. */
  tools: boolean;
  /**
   * Реальный вес описаний инструментов из последнего прогона: его знает main.
   * Без него панель считала бы по всему списку и показывала не то, что уходит.
   */
  toolsTokens?: number;
  /** Сколько токенов отдано под ответ. */
  reservedTokens: number;
  usage?: ChatUsage;
  /** Явный размер окна из настроек; не задан — считается по имени модели. */
  contextWindow?: number;
  /**
   * Вопрос, который вот-вот уйдёт в модель, но ещё не попал в историю. Без него
   * оценка перед отправкой занижена ровно на вес отправляемого сообщения.
   */
  pending?: string;
}

export interface SessionInfoView {
  element: HTMLElement;
  readonly visible: boolean;
  show(data: SessionInfoData): void;
  hide(): void;
}

interface Part {
  key: string;
  label: string;
  tokens: number;
  /** Уточнение состава части: сколько из неё пришлось на что. */
  note?: string;
  /**
   * Что именно уходит в модель за эту часть — по строке на кусок.
   * Цифра без содержимого ничего не объясняет: «системные — 4 200» не
   * подсказывает, что из промпта выкинуть, чтобы стало 3 500.
   */
  detail(): string[];
  /**
   * Можно ли снять часть и за счёт чего. Пусто — часть неотъемлемая:
   * без системных инструкций и описаний инструментов агент не работает,
   * а историю не «выключают», её сжимают (кнопка внизу).
   */
  drop?: { label: string; run(): void };
}

/**
 * Раскрытый текст части. Длинные куски режем: панель — подсказка, а не читалка.
 * Ограничение по символам, а не по строкам: одна строка кода бывает на экран.
 */
const DETAIL_LIMIT = 1200;

function clip(text: string): string {
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}\n…` : text;
}

/** Однострочная подпись куска: переводы строк ломают список.
 */
function oneLine(text: string, limit = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * Подпись к части «Файлы»: из чего она набралась.
 *
 * Считаем тем же `estimateAttachmentTokens`, что и сам вес, — иначе надпись
 * и число разъедутся. Больше двух вложений перечислять смысла нет: строка
 * узкая, а полный список виден по чипам в композере.
 */
function attachmentNote(attachments: readonly ChatAttachment[]): string {
  if (attachments.length === 0) return '';
  const labelled = attachments
    .slice(0, 2)
    .map((item) => `${item.label} — ${formatTokens(estimateAttachmentTokens(item))}`);
  const rest = attachments.length - labelled.length;
  return rest > 0 ? `${labelled.join(', ')}, ещё ${rest}` : labelled.join(', ');
}

/**
 * Что занимает место в контексте: разбивка по частям запроса (см. `context-fit`).
 *
 * `detail` и `drop` собираются из тех же `data`, что и вес: строка должна
 * объяснять ровно ту цифру, что стоит рядом с ней.
 */
function split(data: SessionInfoData, options: { onDropFiles?(): void }): Part[] {
  const parts = estimateContextParts(data);
  const toolNames = AGENT_TOOLS.map((tool) => tool.name);
  const fileLines = data.attachments.map((item) => `${item.label} — ${formatTokens(estimateAttachmentTokens(item))}`);
  return [
    {
      key: 'system',
      label: 'Системные инструкции',
      tokens: parts.system,
      detail: () => [
        ...(data.systemPrompt ? [clip(data.systemPrompt)] : []),
        ...(data.instructions && data.instructions.length > 0
          ? appliedInstructionsLines(data.instructions).map((line) => `Правила проекта: ${line}`)
          : []),
      ],
    },
    {
      key: 'tools',
      label: 'Описания инструментов',
      tokens: parts.tools,
      detail: () =>
        data.tools
          ? [
              `Схемы ${toolNames.length} инструментов: ${toolNames.join(', ')}`,
              'Убрать их нельзя: без схем агент не вызовет ни одного инструмента.',
            ]
          : ['Описания моделям не передаются: у выбранной модели вызов инструментов выключен.'],
    },
    {
      key: 'messages',
      label: 'Сообщения',
      tokens: parts.messages,
      detail: () => {
        const counts = new Map<string, number>();
        for (const message of data.history) {
          if (message.role === 'tool') continue;
          counts.set(message.role, (counts.get(message.role) ?? 0) + 1);
        }
        const lines = [...counts].map(([role, count]) => `${roleLabel(role)}: ${count}`);
        if (data.pending) lines.push(`Ещё не отправлено: ${oneLine(data.pending)}`);
        if (lines.length === 0) return [];
        return [...lines, 'Выключить историю нельзя — её сжимают кнопкой внизу.'];
      },
    },
    {
      key: 'results',
      label: 'Результаты инструментов',
      tokens: parts.results,
      detail: () => {
        const results = data.history.filter((message) => message.role === 'tool');
        if (results.length === 0) return [];
        // Самые тяжёлые — первыми: чистить имеет смысл именно их.
        const heavy = results
          .map((message) => ({
            name: message.name ?? 'инструмент',
            tokens: estimateTextTokens(message.content ?? ''),
          }))
          .sort((a, b) => b.tokens - a.tokens)
          .slice(0, 5)
          .map((item) => `${item.name} — ${formatTokens(item.tokens)}`);
        return [`Всего ответов: ${results.length}`, ...heavy];
      },
    },
    {
      key: 'files',
      label: 'Файлы',
      tokens: parts.files,
      detail: () => fileLines,
      drop:
        options.onDropFiles && data.attachments.length > 0
          ? { label: 'Убрать все', run: options.onDropFiles }
          : undefined,
    },
  ];
}

/** Роль сообщения по-русски: модель, человек и инструмент — не `user`/`assistant`. */
function roleLabel(role: string): string {
  if (role === 'user') return 'Вопросы';
  if (role === 'assistant') return 'Ответы модели';
  return role;
}

/**
 * Кольцо заполнения контекста — кнопка «Информация о сессии» в полосе статуса.
 * В неё же встают значок режима и искра состояния ассистента (см. `chat.ts`),
 * поэтому это единственный виджет AI в полосе.
 */
export interface UsageRing {
  element: HTMLButtonElement;
  set(usage: ContextUsage): void;
}

/** Радиус и длина окружности кольца: длина нужна для штриховой дуги. */
const RING_RADIUS = 6.5;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

export function createUsageRing(onClick: () => void): UsageRing {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 18 18');
  svg.setAttribute('width', '15');
  svg.setAttribute('height', '15');
  svg.setAttribute('fill', 'none');

  const circle = (className: string): SVGCircleElement => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    node.setAttribute('cx', '9');
    node.setAttribute('cy', '9');
    node.setAttribute('r', String(RING_RADIUS));
    node.setAttribute('stroke-width', '2');
    node.setAttribute('class', className);
    return node;
  };

  const track = circle('ring-track');
  const value = circle('ring-value');
  value.setAttribute('stroke-dasharray', String(RING_LENGTH));
  value.setAttribute('stroke-dashoffset', String(RING_LENGTH));
  // Поворачиваем на −90°, иначе рост дуги начинается не сверху.
  value.setAttribute('transform', 'rotate(-90 9 9)');
  svg.append(track, value);

  // Процент — обычным текстом полосы: своего шрифта и кегля у него нет.
  const percent = h('span', {}, '0%');
  const element = h(
    'button',
    { class: 'context-ring', type: 'button', title: 'Информация о сессии', onClick },
    svg,
    percent,
  );

  return {
    element,
    set(usage) {
      value.setAttribute('stroke-dashoffset', String(RING_LENGTH * (1 - usage.percent / 100)));
      percent.textContent = `${usage.percent}%`;
      // Цвет говорит о запасе лучше числа: синий — запас есть, жёлтый — тесно, красный — предел.
      element.classList.toggle('is-tight', usage.percent >= 75 && usage.percent < 90);
      element.classList.toggle('is-full', usage.percent >= 90);
      element.title =
        `Информация о сессии\nКонтекст: ${usage.exact ? '' : '≈ '}${formatTokens(usage.used)} из ${formatTokens(usage.limit)} токенов` +
        '\nНажмите, чтобы посмотреть состав и сжать беседу';
    },
  };
}

export function createSessionInfo(options: {
  onCompact(): void;
  balance?(): Promise<AccountBalance | null>;
  /**
   * Снять все вложения разом. По одному они снимаются в чипах; здесь — когда
   * файлов набралось столько, что кликать по каждому дольше, чем начать заново.
   */
  onDropFiles?(): void;
}): SessionInfoView {
  const title = h('div', { class: 'session-info-title' }, svgIcon('info', 13), h('span', {}, 'Информация о сессии'));
  const contextHead = h('div', { class: 'session-info-sub' }, 'Контекстное окно');
  const gaugeValue = h('span', { class: 'session-info-value' });
  const gaugePercent = h('span', { class: 'session-info-percent' });
  const gaugeBar = h('div', { class: 'context-bar' });
  const reservedNote = h('div', { class: 'session-info-reserved' });
  // Остаток на счёте у провайдера. Строки нет, пока balance не ответил или
  // провайдер такого не умеет (локальные и большинство OpenAI-совместимых).
  const balanceNote = h('div', { class: 'field-hint session-info-balance', hidden: true });
  const list = h('div', { class: 'session-info-list' });

  const compactButton = h(
    'button',
    { class: 'btn btn-small session-info-compact', type: 'button', onClick: () => options.onCompact() },
    svgIcon('collapse', 13),
    h('span', {}, 'Сжать беседу'),
  );

  const element = h(
    'div',
    { class: 'session-info', hidden: true },
    title,
    contextHead,
    h('div', { class: 'session-info-gauge' }, gaugeValue, gaugePercent),
    gaugeBar,
    reservedNote,
    balanceNote,
    list,
    compactButton,
  );

  let open = false;
  // Раскрытые строки контекста: помним между отрисовками, иначе панель,
  // обновляясь на каждой правке, захлопывала бы только что открытую строку.
  const folded = new Set<string>();

  function render(data: SessionInfoData): void {
    const parts = split(data, { onDropFiles: options.onDropFiles });
    const estimated = parts.reduce((sum, part) => sum + part.tokens, 0);
    const real = data.usage?.promptTokens;
    // Масштаб: сумма частей догоняет реальный размер запроса, пропорции сохраняются.
    const scale = real !== undefined && estimated > 0 ? real / estimated : 1;
    const usage = contextUsage(data);
    const used = usage.used;
    const limit = usage.limit;
    const percent = usage.percent;

    for (const part of parts) {
      part.tokens = Math.round(part.tokens * scale);
      // Отдельный вес вложения: строки «Файлы» недостаточно. С картинками она
      // врёт вдвое — считает только текст, а весит картинка.
      part.note = part.key === 'files' ? attachmentNote(data.attachments) : '';
    }
    const total = parts.reduce((sum, part) => sum + part.tokens, 0);

    gaugeValue.textContent =
      real !== undefined
        ? `${formatTokens(used)} / ${formatTokens(limit)} токенов`
        : `≈ ${formatTokens(used)} / ${formatTokens(limit)} токенов`;
    gaugePercent.textContent = `${percent}%`;

    clear(gaugeBar);
    for (const part of parts) {
      if (part.tokens <= 0) continue;
      gaugeBar.appendChild(
        h('span', {
          class: `context-seg context-seg-${part.key}`,
          title: part.label,
          style: { width: `${total > 0 ? (part.tokens / total) * 100 : 0}%` },
        }),
      );
    }

    reservedNote.textContent = `Зарезервировано для ответа: ${formatTokens(data.reservedTokens)}`;
    reservedNote.hidden = data.reservedTokens <= 0;

    // Расход последнего обмена и за всю беседу здесь не показываем: строки
    // «Последний обмен: …» и «За беседу: …» были ценой и скоростью, а не
    // подсказкой для работы. Остались контекст, запас и баланс.

    clear(list);
    const shown = new Set(folded);
    for (const part of parts) {
      const share = total > 0 ? (part.tokens / total) * 100 : 0;
      const isOpen = shown.has(part.key) && part.tokens > 0;
      list.appendChild(
        h(
          'div',
          { class: `session-info-item${isOpen ? ' is-open' : ''}` },
          h(
            'button',
            {
              class: 'session-info-row',
              type: 'button',
              title: part.tokens > 0 ? part.note || 'Показать, из чего сложилась часть' : part.note,
              // Раскрытие — не ради галочки: цифра без содержимого не подсказывает,
              // что именно выкинуть, чтобы стало меньше. Пустую часть не раскрываем.
              onclick: () => {
                if (part.tokens <= 0) return;
                if (shown.has(part.key)) shown.delete(part.key);
                else shown.add(part.key);
                folded.clear();
                for (const key of shown) folded.add(key);
                render(data);
              },
            },
            h(
              'span',
              { class: 'session-info-label' },
              h('span', { class: `context-dot context-seg-${part.key}` }),
              part.label,
              part.note ? h('span', { class: 'session-info-note' }, part.note) : '',
            ),
            h('span', { class: 'session-info-share' }, `${share.toFixed(1)}%`),
            h('span', { class: 'session-info-tokens' }, formatTokens(part.tokens)),
          ),
        ),
      );
      if (!isOpen) continue;
      const lines = part.detail();
      const box = h('div', { class: 'session-info-detail' });
      if (lines.length === 0)
        box.appendChild(h('div', { class: 'session-info-detail-empty' }, 'Пусто — эта часть ничего не весит.'));
      for (const line of lines) {
        // Многострочный кусок (системный промпт) — в <pre>: пробелы в нём значимы.
        box.appendChild(
          line.includes('\n')
            ? h('pre', { class: 'session-info-detail-pre' }, line)
            : h('div', { class: 'session-info-detail-line' }, line),
        );
      }
      if (part.drop) {
        const button = h('button', { class: 'session-info-detail-drop', type: 'button' }, part.drop.label);
        button.title = 'Снять эту часть контекста с этого хода';
        button.addEventListener('click', (event) => {
          // Клик по кнопке — не клик по строке: иначе она бы ещё и свернулась.
          event.stopPropagation();
          part.drop?.run();
        });
        box.appendChild(button);
      } else if (part.tokens > 0) {
        // Молчание читалось как недоделка: «почему у файлов кнопка есть, а у
        // инструкций нет». Части, без которых агент перестанет быть агентом,
        // прямо говорят, что выключателя у них нет.
        box.appendChild(h('div', { class: 'session-info-detail-locked' }, 'Эту часть убрать нельзя'));
      }
      list.appendChild(box);
    }

    // Строку про деньги здесь не трогаем: баланс приходит отдельным запросом
    // (см. `show`), а `render` вызывается и тогда, когда ответа ещё нет.

    compactButton.disabled = data.history.length === 0;
    compactButton.title =
      data.history.length === 0
        ? 'Беседа пуста — сжимать нечего'
        : 'Заменить историю кратким пересказом, чтобы освободить контекст';
  }

  return {
    element,
    get visible() {
      return open;
    },
    show(data) {
      render(data);
      element.hidden = false;
      open = true;
      // Баланс — отдельный запрос к провайдеру: ответ приходит позже, чем сам
      // попап. Спрашиваем, когда окно уже видно, и дописываем строку в
      // отрисованный список; закрыли окно до ответа — молча забываем цифру.
      void options.balance?.().then((balance) => {
        if (!open) return;
        if (balance === null) {
          balanceNote.hidden = true;
          return;
        }
        balanceNote.textContent = formatBalance(balance);
        balanceNote.hidden = false;
      });
    },
    hide() {
      element.hidden = true;
      open = false;
    },
  };
}
