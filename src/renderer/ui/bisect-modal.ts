import type { GitBisectState } from '../../shared/git-bisect';
import type { GitModel } from '../core/git-model';
import { h } from './dom';
import { createModal } from './modal';

export interface BisectModalDeps {
  git: GitModel;
  /** Открыть коммит, найденный поиском, — посмотреть, что в нём. */
  openCommit(commit: string): void;
  notify(message: string, kind?: 'info' | 'error'): void;
}

export interface BisectModalView {
  element: HTMLElement;
  open(): Promise<void>;
  close(): void;
}

/**
 * Экран пошагового поиска «багованного» коммита (`git bisect`).
 *
 * Bisect — это диалог: git переставляет ветку на середину отрезка между известным
 * хорошим и плохим коммитами, а человек проверяет этот коммит и говорит, хорош он
 * или плох; отрезок делится пополам, пока не найдётся виновник. Окно показывает,
 * что сейчас проверять, сколько осталось, и даёт три ответа плюс «пропустить»
 * (когда коммит проверить нельзя) и «закончить».
 *
 * Начало поиска: если он ещё не идёт, сначала выбираются известные коммиты. Ветку
 * для проверки git двигает сам — на время поиска рабочее дерево в состоянии
 * «отделённого указателя», и об этом в окне сказано.
 */
export function createBisectModal(deps: BisectModalDeps): BisectModalView {
  let state: GitBisectState | null = null;
  let busy = false;

  const headline = h('div', { class: 'bisect-headline' });
  const detail = h('div', { class: 'bisect-detail' });
  const message = h('pre', { class: 'bisect-message' });

  const startBad = h('input', { class: 'field-input', type: 'text', spellcheck: false, placeholder: 'плохой коммит' });
  const startGood = h('input', {
    class: 'field-input',
    type: 'text',
    spellcheck: false,
    placeholder: 'хороший коммит',
  });
  const startRow = h(
    'div',
    { class: 'bisect-start', hidden: true },
    h('span', { class: 'field-label' }, 'Известные коммиты:'),
    startBad,
    h('span', { class: 'bisect-sep' }, '…хороший:'),
    startGood,
    h('button', { class: 'btn btn-primary', type: 'button', onClick: () => void start() }, 'Начать поиск'),
  );

  const actionButton = (label: string, hint: string, run: () => void, primary = false): HTMLElement =>
    h('button', { class: `btn${primary ? ' btn-primary' : ''}`, type: 'button', title: hint, onClick: run }, label);

  const goodButton = actionButton('Хороший', 'Коммит работает: искать в более новых', () => void mark('good'), true);
  const badButton = actionButton('Плохой', 'Коммит не работает: искать в более старых', () => void mark('bad'), true);
  const skipButton = actionButton(
    'Пропустить',
    'Этот коммит не проверить (например, не собирается)',
    () => void mark('skip'),
  );
  const resetButton = actionButton('Закончить', 'Прервать поиск и вернуть ветку на место', () => void reset());

  // Кнопка «открыть коммит» живёт постоянно: её видно только когда поиск нашёл
  // виновника, но создавать её на каждую отрисовку нельзя — узлы копились бы.
  const openCommitButton = h(
    'button',
    { class: 'btn', type: 'button', hidden: true, onClick: () => openFound() },
    'Открыть коммит',
  );

  // Действия — подвал окна. Пока поиск не идёт, подвал скрыт целиком: пустая
  // полоса с рамкой на месте кнопок выглядела бы поломкой.
  const footer = h(
    'footer',
    { class: 'modal-footer is-start', hidden: true },
    openCommitButton,
    goodButton,
    badButton,
    skipButton,
    resetButton,
  );

  const modal = createModal({
    className: 'bisect-modal',
    title: 'Поиск багованного коммита (bisect)',
    footer,
  });
  modal.body.append(headline, detail, startRow, message);

  const close = (): void => modal.close();

  /** Показать состояние: заголовок, место проверки и доступные действия. */
  const render = (): void => {
    const current = state;
    message.textContent = current?.message ?? '';
    message.hidden = !current?.message;

    if (!current || (!current.active && !current.firstBad)) {
      // Поиск не идёт: предлагаем начать.
      headline.textContent = 'Поиск не идёт';
      detail.textContent =
        'Укажите известный плохой коммит и известный хороший (можно оставить «плохой» пустым — им станет текущий). ' +
        'Дальше git будет сам переставлять ветку, а вы отмечаете проверенные коммиты.';
      startRow.hidden = false;
      footer.hidden = true;
      return;
    }

    if (current.firstBad) {
      headline.textContent = `Первый плохой коммит: ${current.firstBad}`;
      detail.textContent =
        'Поиск нашёл виновника. Нажмите на него, чтобы посмотреть изменения, и «Закончить», чтобы вернуть ветку.';
      startRow.hidden = true;
      footer.hidden = false;
      goodButton.hidden = true;
      badButton.hidden = true;
      skipButton.hidden = true;
      resetButton.hidden = false;
      openCommitButton.hidden = false;
      return;
    }

    headline.textContent = current.current
      ? `Проверьте: ${current.current.hash} — ${current.current.summary}`
      : 'Идёт поиск';
    const left = current.remaining === null ? '' : `Осталось версий: ${current.remaining}`;
    const steps = current.steps === null ? '' : `примерно шагов: ${current.steps}`;
    detail.textContent = [left, steps].filter(Boolean).join(' · ') || 'git ещё не назвал остаток';
    startRow.hidden = true;
    footer.hidden = false;
    goodButton.hidden = false;
    badButton.hidden = false;
    skipButton.hidden = false;
    resetButton.hidden = false;
    openCommitButton.hidden = true;
  };

  /** Открыть найденный коммит — посмотреть, что в нём изменилось. */
  const openFound = (): void => {
    if (state?.firstBad) deps.openCommit(state.firstBad);
  };

  const apply = (next: GitBisectState): void => {
    state = next;
    render();
  };

  const read = async (): Promise<void> => {
    try {
      apply(await deps.git.bisectState());
    } catch (error) {
      deps.notify(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  async function start(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const bad = startBad.value.trim();
      const good = startGood.value.trim();
      apply(await deps.git.bisectStart({ bad: bad || undefined, good: good || undefined }));
      if (!state?.active && !state?.firstBad) deps.notify(state?.message || 'Поиск не начался', 'error');
    } catch (error) {
      deps.notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      busy = false;
    }
  }

  async function mark(where: 'good' | 'bad' | 'skip'): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      apply(await deps.git.bisectMark(where));
    } catch (error) {
      deps.notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      busy = false;
    }
  }

  async function reset(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      await deps.git.bisectReset();
      state = null;
      render();
      deps.notify('Поиск закончен, ветка на прежнем месте');
    } catch (error) {
      deps.notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      busy = false;
    }
  }

  async function open(): Promise<void> {
    modal.open();
    state = null;
    render();
    await read();
  }

  return { element: modal.element, open, close };
}
