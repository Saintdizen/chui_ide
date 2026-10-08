import type { ChatAttachment, ChatMessage, ChatUsage } from '../../shared/api';
import { AGENT_TOOLS } from '../../shared/tools';
import { contextWindow } from '../../shared/providers';
import { clear, h, svgIcon } from './dom';

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
  /** Предлагаются ли модели описания инструментов. */
  tools: boolean;
  /** Сколько токенов отдано под ответ. */
  reservedTokens: number;
  usage?: ChatUsage;
}

export interface SessionInfoView {
  element: HTMLElement;
  readonly visible: boolean;
  show(data: SessionInfoData): void;
  hide(): void;
}

/** Сколько контекста занято: итог — реальный, если провайдер его сообщил. */
export interface ContextUsage {
  used: number;
  limit: number;
  percent: number;
  /** Итог известен точно или пока оценён по символам. */
  exact: boolean;
}

interface Part {
  key: string;
  label: string;
  tokens: number;
}

/**
 * Символов на токен. 3.5 — середина для смеси русского текста, кода и латиницы:
 * латиница и код дают ~4, кириллица в моделях дороже. Точное число знает только
 * токенизатор провайдера, поэтому итог калибруется по `usage`.
 */
const CHARS_PER_TOKEN = 3.5;

function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Короткая запись числа: 1 200 → «1.2K». */
function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

/** Что занимает место в контексте: считаем по символам, показываем после калибровки. */
function split(data: SessionInfoData): Part[] {  let messages = 0;
  let results = 0;

  for (const message of data.history) {
    const size = (message.content ?? '').length + (message.name?.length ?? 0);
    if (message.role === 'tool') results += size;
    else messages += size;
  }

  const files = data.attachments.reduce((sum, item) => sum + item.text.length, 0);
  const toolDefs = data.tools ? JSON.stringify(AGENT_TOOLS).length : 0;

  return [
    { key: 'system', label: 'Системные инструкции', tokens: estimateTokens(data.systemPrompt.length) },
    { key: 'tools', label: 'Описания инструментов', tokens: estimateTokens(toolDefs) },
    { key: 'messages', label: 'Сообщения', tokens: estimateTokens(messages) },
    { key: 'results', label: 'Результаты инструментов', tokens: estimateTokens(results) },
    { key: 'files', label: 'Файлы', tokens: estimateTokens(files) },
  ];
}

/**
 * Заполнение контекстного окна. Итог берём у провайдера (`prompt_tokens`),
 * а пока его нет — считаем по символам: без знаменателя заполнение не показать.
 */
export function contextUsage(data: SessionInfoData): ContextUsage {
  const estimated = split(data).reduce((sum, part) => sum + part.tokens, 0);
  const used = data.usage?.promptTokens ?? estimated;
  const limit = contextWindow(data.model);
  return {
    used,
    limit,
    percent: limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0,
    exact: data.usage?.promptTokens !== undefined,
  };
}

/** Кольцо с процентом заполнения — кнопка «Информация о сессии» в углу композера. */
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

  const percent = h('span', { class: 'ring-percent' }, '0%');
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
        `Контекст: ${usage.exact ? '' : '≈ '}${formatTokens(usage.used)} из ${formatTokens(usage.limit)} токенов` +
        '\nНажмите, чтобы посмотреть состав и сжать беседу';
    },
  };
}

export function createSessionInfo(options: { onCompact(): void }): SessionInfoView {
  const title = h('div', { class: 'session-info-title' }, svgIcon('info', 13), h('span', {}, 'Информация о сессии'));
  const contextHead = h('div', { class: 'session-info-sub' }, 'Контекстное окно');
  const gaugeValue = h('span', { class: 'session-info-value' });
  const gaugePercent = h('span', { class: 'session-info-percent' });
  const gaugeBar = h('div', { class: 'context-bar' });
  const reservedNote = h('div', { class: 'session-info-reserved' });
  const list = h('div', { class: 'session-info-list' });
  const note = h('div', { class: 'field-hint session-info-note' });

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
    list,
    note,
    compactButton,
  );

  let open = false;

  function render(data: SessionInfoData): void {
    const parts = split(data);
    const estimated = parts.reduce((sum, part) => sum + part.tokens, 0);
    const real = data.usage?.promptTokens;
    // Масштаб: сумма частей догоняет реальный размер запроса, пропорции сохраняются.
    const scale = real !== undefined && estimated > 0 ? real / estimated : 1;
    const usage = contextUsage(data);
    const used = usage.used;
    const limit = usage.limit;
    const percent = usage.percent;

    for (const part of parts) part.tokens = Math.round(part.tokens * scale);
    const total = parts.reduce((sum, part) => sum + part.tokens, 0);

    gaugeValue.textContent = real !== undefined ? `${formatTokens(used)} / ${formatTokens(limit)} токенов` : `≈ ${formatTokens(used)} / ${formatTokens(limit)} токенов`;
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

    clear(list);
    for (const part of parts) {
      const share = total > 0 ? (part.tokens / total) * 100 : 0;
      list.appendChild(
        h(
          'div',
          { class: 'session-info-row' },
          h('span', { class: 'session-info-label' }, h('span', { class: `context-dot context-seg-${part.key}` }), part.label),
          h('span', { class: 'session-info-share' }, `${share.toFixed(1)}%`),
        ),
      );
    }

    // Про источник чисел говорим прямо: иначе «≈» выглядит как ошибка округления.
    note.textContent =
      real !== undefined
        ? 'Итог — из последнего ответа модели, разбивка — по объёму частей запроса.'
        : 'Оценка: провайдер сообщит точный размер в следующем ответе.';
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
    },
    hide() {
      element.hidden = true;
      open = false;
    },
  };
}
