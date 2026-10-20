/**
 * Панель живых агентов: кто работает, чем занят и как его снять.
 *
 * Подзадача видна в ленте карточкой вызова, но карточка — снимок: она говорит
 * «выполняется» и всё. А агентов запускают пачкой (`task` с несколькими заданиями,
 * `run_code` с kind «workflow», `spawn` у `agents`), и человеку нужно другое: сколько их, что каждый
 * делает сейчас, сколько шагов прошёл — и возможность снять одного, не снимая
 * остальных. Поэтому панель, а не ещё одна строка в ленте: ленту прокручивают,
 * а панель стоит над полем ввода и видна всегда, как цель работы.
 *
 * Живёт панель на push-событии (`PushTopic.Agents`): main шлёт список при каждом
 * изменении, поэтому шаги растут на глазах, без опроса по таймеру. Список один на
 * окно: агента запустил прогон другой вкладки — видно всё равно, и это правильно,
 * он работает на тот же проект.
 *
 * Действия — значками, как у остальных кнопок чата: «остановить» и «сказать».
 * Подпись не нужна: рядом текст агента, и кнопка с текстом отняла бы у него место.
 */

import { agentActivityLabel, agentStatusLabel, formatElapsed, type AgentSnapshot } from '../../shared/agents';
import { h, svgIcon } from './dom';

export interface AgentsPanelDeps {
  /** Остановить агента (человек нажал «стоп»). */
  interrupt(id: string): void;
  /** Сказать агенту по делу: доедет перед его следующим шагом. */
  message(id: string, text: string): void;
}

export interface AgentsPanelView {
  element: HTMLElement;
  /** Показать список; пустой список прячет панель. */
  render(agents: readonly AgentSnapshot[]): void;
  /** Спрятать (беседа без агентов). */
  hide(): void;
  /** Свёрнута ли панель в строку. */
  readonly collapsed: boolean;
}

/** Агент, которому набирают сообщение: поле открыто только у одного. */
interface MessageBox {
  id: string;
  input: HTMLInputElement;
  row: HTMLElement;
}

export function createAgentsPanel(deps: AgentsPanelDeps): AgentsPanelView {
  const element = h('div', { class: 'composer-agents', hidden: true });
  let collapsed = false;
  let box: MessageBox | null = null;
  let current: readonly AgentSnapshot[] = [];

  /** Заголовок панели: сколько всего и кто в каком состоянии. */
  function summary(agents: readonly AgentSnapshot[]): string {
    const running = agents.filter((agent) => agent.status === 'running').length;
    const finished = agents.length - running;
    const parts = [`Агенты: ${agents.length}`];
    if (running > 0) parts.push(`работают ${running}`);
    if (finished > 0) parts.push(`закончили ${finished}`);
    return parts.join(' · ');
  }

  /** Поле сообщения: Enter отправляет, Esc закрывает. */
  function createBox(id: string): MessageBox {
    const input = h('input', {
      class: 'agent-message',
      type: 'text',
      placeholder: 'Что уточнить агенту…',
      'aria-label': 'Сообщение агенту',
    });
    const row = h(
      'div',
      { class: 'agent-message-row' },
      input,
      h('button', { class: 'btn btn-small', type: 'button', onClick: () => send(id) }, 'Сказать'),
      h(
        'button',
        { class: 'btn btn-small', type: 'button', title: 'Закрыть без отправки', onClick: () => close() },
        'Отмена',
      ),
    );
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        send(id);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    });
    return { id, input, row };
  }

  function send(id: string): void {
    const text = box?.input.value.trim() ?? '';
    if (!text) return;
    deps.message(id, text);
    close();
  }

  function close(): void {
    box = null;
    paint();
  }

  /** Строка агента: описание, состояние, чем занят, время и действия. */
  function agentRow(agent: AgentSnapshot): HTMLElement {
    const running = agent.status === 'running';
    const actions = h('div', { class: 'agent-actions' });
    if (running) {
      actions.appendChild(
        h(
          'button',
          {
            class: 'icon-btn',
            type: 'button',
            title: 'Остановить этого агента (остальные продолжат)',
            'aria-label': 'Остановить агента',
            onClick: () => deps.interrupt(agent.id),
          },
          svgIcon('stop', 12),
        ),
      );
      actions.appendChild(
        h(
          'button',
          {
            class: 'icon-btn',
            type: 'button',
            title: 'Сказать агенту: доедет перед его следующим шагом',
            'aria-label': 'Сообщение агенту',
            onClick: () => {
              box = box?.id === agent.id ? null : createBox(agent.id);
              paint();
              box?.input.focus();
            },
          },
          svgIcon('send', 12),
        ),
      );
    }

    const meta = h(
      'span',
      { class: 'agent-meta' },
      `${agent.id} · ${agentStatusLabel(agent.status)}${running ? ` · ${formatElapsed(Date.now() - agent.startedAt)}` : ''}`,
    );
    const row = h(
      'div',
      { class: `agent-row is-${agent.status}` },
      h('div', { class: 'agent-line' }, h('span', { class: 'agent-name' }, agent.description), meta),
      h(
        'div',
        { class: 'agent-line' },
        h('span', { class: 'agent-activity' }, agentActivityLabel(agent)),
        h('div', { class: 'agent-spacer' }),
        actions,
      ),
    );
    if (box?.id === agent.id && running) row.appendChild(box.row);
    return row;
  }

  function paint(): void {
    if (current.length === 0) {
      element.hidden = true;
      element.replaceChildren();
      return;
    }
    element.hidden = false;

    const toggle = h(
      'button',
      {
        class: 'icon-btn agent-toggle',
        type: 'button',
        title: collapsed ? 'Показать агентов' : 'Свернуть список',
        'aria-label': collapsed ? 'Показать агентов' : 'Свернуть список',
        onClick: () => {
          collapsed = !collapsed;
          paint();
        },
      },
      svgIcon(collapsed ? 'chevronDown' : 'chevronUp', 12),
    );

    const head = h(
      'div',
      { class: 'agents-head' },
      svgIcon('sparkle', 12),
      h('span', { class: 'agents-title' }, summary(current)),
      h('div', { class: 'agent-spacer' }),
      toggle,
    );

    const body = h('div', { class: 'agents-body' });
    if (collapsed) {
      // Свёрнутая панель называет только идущих: «кто ещё занят» — вопрос в один взгляд.
      const running = current.filter((agent) => agent.status === 'running');
      if (running.length > 0) {
        body.appendChild(
          h('span', { class: 'agents-collapsed' }, running.map((agent) => agent.description).join(', ')),
        );
      }
    } else {
      for (const agent of current) body.appendChild(agentRow(agent));
    }

    element.replaceChildren(h('div', { class: 'agents-card' }, head, body));
  }

  return {
    element,
    get collapsed(): boolean {
      return collapsed;
    },
    render(agents: readonly AgentSnapshot[]): void {
      current = agents;
      // Поле открыто у агента, которого уже нет (закончил) — закрываем: писать некому.
      if (box !== null && !agents.some((agent) => agent.id === box?.id && agent.status === 'running')) box = null;
      paint();
    },
    hide(): void {
      current = [];
      box = null;
      element.hidden = true;
      element.replaceChildren();
    },
  };
}
