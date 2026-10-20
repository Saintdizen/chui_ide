import type { ChatAttachment, ChatMessage, ChatRunTrace, ChatUsage } from '../../shared/api';
import { contextUsage, estimateContextParts, type ContextUsage } from '../../shared/context-fit';
import { formatCost, formatTokens, peakTariffHint, usageCost } from '../../shared/usage';
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
  /**
   * Реальный вес описаний инструментов из последнего прогона: его знает main.
   * Без него панель считала бы по всему списку и показывала не то, что уходит.
   */
  toolsTokens?: number;
  /** Сколько токенов отдано под ответ. */
  reservedTokens: number;
  usage?: ChatUsage;
  /** Скорость последнего ответа в токенах в секунду: считается в чате. */
  speed?: number;
  /** Накопленный расход беседы: шаги, вызовы и токены за всё время. */
  trace?: ChatRunTrace;
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
}

/** Что занимает место в контексте: разбивка по частям запроса (см. `context-fit`). */
function split(data: SessionInfoData): Part[] {
  const parts = estimateContextParts(data);
  return [
    { key: 'system', label: 'Системные инструкции', tokens: parts.system },
    { key: 'tools', label: 'Описания инструментов', tokens: parts.tools },
    { key: 'messages', label: 'Сообщения', tokens: parts.messages },
    { key: 'results', label: 'Результаты инструментов', tokens: parts.results },
    { key: 'files', label: 'Файлы', tokens: parts.files },
  ];
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

export function createSessionInfo(options: { onCompact(): void }): SessionInfoView {
  const title = h('div', { class: 'session-info-title' }, svgIcon('info', 13), h('span', {}, 'Информация о сессии'));
  const contextHead = h('div', { class: 'session-info-sub' }, 'Контекстное окно');
  const gaugeValue = h('span', { class: 'session-info-value' });
  const gaugePercent = h('span', { class: 'session-info-percent' });
  const gaugeBar = h('div', { class: 'context-bar' });
  const reservedNote = h('div', { class: 'session-info-reserved' });
  const usageNote = h('div', { class: 'field-hint session-info-usage' });
  const traceNote = h('div', { class: 'field-hint session-info-trace', hidden: true });
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
    usageNote,
    traceNote,
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

    // Реальные токены последнего обмена: у провайдера их два числа — запрос и ответ.
    const completion = data.usage?.completionTokens;
    if (real !== undefined || completion !== undefined || data.speed !== undefined) {
      const parts: string[] = [];
      const cached = data.usage?.cachedTokens;
      if (real !== undefined) {
        parts.push(`запрос ${formatTokens(real)}${cached ? ` (кеш ${formatTokens(cached)})` : ''}`);
      }
      if (completion !== undefined) parts.push(`ответ ${formatTokens(completion)}`);
      // Стоимость — только когда модель есть в таблице цен: иначе это гадание.
      const cost = usageCost(data.usage, data.model);
      if (cost !== null) parts.push(`стоимость ≈ $${formatCost(cost)}`);
      // Тариф зависит от часа: подсказка только тогда, когда это действительно дорого.
      const peak = peakTariffHint(data.model);
      if (peak) parts.push(peak);
      if (data.speed !== undefined && data.speed > 0) parts.push(`${data.speed.toFixed(1)} tok/s`);
      usageNote.textContent = `Последний обмен: ${parts.join(' · ')}`;
      usageNote.hidden = false;
    } else {
      usageNote.hidden = true;
    }

    // Накопленный расход беседы: видно, во сколько она обошлась за всё время, а не
    // только последний шаг. Стоимость — как и выше, лишь для известной модели.
    const trace = data.trace;
    const traceTokens = (trace?.usage.promptTokens ?? 0) + (trace?.usage.completionTokens ?? 0);
    if (trace && traceTokens > 0) {
      const bits: string[] = [];
      if (trace.steps > 0) bits.push(`шагов ${trace.steps}`);
      if (trace.toolCalls > 0) bits.push(`вызовов ${trace.toolCalls}`);
      bits.push(`токенов ${formatTokens(traceTokens)}`);
      const total = usageCost(trace.usage, data.model);
      if (total !== null) bits.push(`≈ $${formatCost(total)}`);
      traceNote.textContent = `За беседу: ${bits.join(' · ')}`;
      traceNote.hidden = false;
    } else {
      traceNote.hidden = true;
    }

    clear(list);
    for (const part of parts) {
      const share = total > 0 ? (part.tokens / total) * 100 : 0;
      list.appendChild(
        h(
          'div',
          { class: 'session-info-row' },
          h(
            'span',
            { class: 'session-info-label' },
            h('span', { class: `context-dot context-seg-${part.key}` }),
            part.label,
          ),
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
