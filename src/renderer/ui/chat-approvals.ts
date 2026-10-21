import type { FileEdit } from '../../shared/edits';
import type { PlanExitDecision } from '../../shared/plan-exit';
import { fileWord } from './chat-text';
import { h, svgIcon, type IconName } from './dom';

/**
 * Решения, которые агент спрашивает у человека прямо в ленте чата: ревью правок и
 * подтверждение команды.
 *
 * Оба устроены одинаково: рисуем карточку в ленте, ждём нажатия и отдаём ответ
 * обещанием. Прерванный вызов агента не должен оставить карточку «висеть» — поэтому
 * хозяин (панель чата) регистрирует у нас функцию отмены и зовёт её, когда разговор
 * прерывают (см. `closeApprovals` в `chat.ts`).
 *
 * Здесь только интерфейс и разметка: ни беседы, ни отправки запросов этот модуль
 * не знает. Текст файла для предпросмотра и место вставки приходят снаружи.
 */

/** Ограничения показа: ревью — не редактор, длинные пачки правок ему не нужны. */
const MAX_REVIEW_HUNKS = 20;
const MAX_REVIEW_LINES = 20;

export interface EditPreviewFile {
  path: string;
  error?: string;
  hunks: Array<{ label: string; removed: string[]; added: string[] }>;
  /** Сколько правок не поместилось в предпросмотр. */
  extra?: number;
}

export interface ApprovalHost {
  /** Текущий текст файла: открытый документ или с диска. `null` — прочитать не вышло. */
  readText(path: string): Promise<string | null>;
  /** Вставить карточку решения в ленту. */
  mount(block: HTMLElement): void;
  /** Прокрутить ленту к карточке. */
  scrollToEnd(): void;
  /** Зарегистрировать отмену; возвращает функцию снятия регистрации. */
  register(cancel: () => void): () => void;
}

/**
 * Предпросмотр правок одного файла. Чистая функция: по тексту и правкам строит
 * то, что показываем, — без DOM и запросов. Вынесена отдельно, поэтому проверяется
 * тестами (см. `tests/chat-review.test.ts`).
 */
export function previewFile(file: FileEdit, text: string | null): EditPreviewFile {
  if (text === null) return { path: file.path, error: 'не удалось прочитать файл', hunks: [] };

  const lines = text.split('\n');
  const hunks = file.edits.slice(0, MAX_REVIEW_HUNKS).map((edit) => {
    // Пустой диапазон (начало и конец совпадают) — это вставка: правка ничего не
    // удаляет, и показывать строку как удалённую было бы враньём.
    const insertion = edit.startLine === edit.endLine && edit.startColumn === edit.endColumn;
    return {
      label: edit.startLine === edit.endLine ? `строка ${edit.startLine}` : `строки ${edit.startLine}–${edit.endLine}`,
      removed: insertion ? [] : lines.slice(edit.startLine - 1, edit.endLine).slice(0, MAX_REVIEW_LINES),
      added: edit.newText.length === 0 ? [] : edit.newText.replace(/\n$/, '').split('\n').slice(0, MAX_REVIEW_LINES),
    };
  });

  return { path: file.path, hunks, extra: file.edits.length - hunks.length };
}

export interface EditReview {
  /**
   * Показать предложенные правки и дождаться решения. Ничего не применяет — это
   * делает вызывающий. Возвращает выбранные файлы или `null`, если отклонили всё.
   */
  review(fileEdits: readonly FileEdit[]): Promise<FileEdit[] | null>;
}

export function createEditReview(host: ApprovalHost): EditReview {
  async function review(fileEdits: readonly FileEdit[]): Promise<FileEdit[] | null> {
    const files = await Promise.all(fileEdits.map(async (file) => previewFile(file, await host.readText(file.path))));

    const block = h('div', { class: 'review' });
    const checks: HTMLInputElement[] = [];

    /** Сводка в шапке и подпись кнопки — по числу отмеченных файлов. */
    const head = h('div', { class: 'review-head' }, svgIcon('wrench', 13), h('span', { class: 'review-title' }));
    block.appendChild(head);

    files.forEach((file) => {
      const box = h('input', { class: 'review-check', type: 'checkbox' }) as HTMLInputElement;
      box.checked = true;
      checks.push(box);

      const section = h(
        'div',
        { class: 'review-file' },
        h('label', { class: 'review-file-head' }, box, h('span', { class: 'review-path' }, file.path)),
      );
      if (file.error) section.appendChild(h('div', { class: 'review-error' }, file.error));
      for (const hunk of file.hunks) {
        const group = h('div', { class: 'review-hunk' }, h('div', { class: 'review-range' }, hunk.label));
        for (const line of hunk.removed) group.appendChild(h('div', { class: 'review-del' }, `- ${line}`));
        for (const line of hunk.added) group.appendChild(h('div', { class: 'review-add' }, `+ ${line}`));
        section.appendChild(group);
      }
      if (file.extra) section.appendChild(h('div', { class: 'review-error' }, `… и ещё правок: ${file.extra}`));
      block.appendChild(section);
    });

    let settle: (result: FileEdit[] | null) => void = () => undefined;
    const decision = new Promise<FileEdit[] | null>((resolve) => {
      settle = resolve;
    });

    const checkedIndexes = (): number[] => checks.flatMap((box, index) => (box.checked ? [index] : []));

    /** Решение принято — разбор правок больше не нужен: остаётся строка итога. */
    function finish(approved: boolean, note: string): void {
      unregister();
      const chosen = approved ? checkedIndexes() : [];
      block.classList.toggle('review-rejected', !approved || chosen.length === 0);
      block.classList.add('decision-done');
      const applied = files.filter((_, index) => chosen.includes(index));
      block.replaceChildren(
        h(
          'div',
          { class: 'decision-line' },
          svgIcon('wrench', 12),
          h(
            'span',
            {},
            approved && applied.length > 0
              ? `Правки применены · ${applied.length} ${fileWord(applied.length)}`
              : approved
                ? 'Ничего не выбрано'
                : 'Правки отклонены',
          ),
          note ? h('span', { class: 'decision-status' }, note) : null,
        ),
      );
      settle(approved && chosen.length > 0 ? fileEdits.filter((_, index) => chosen.includes(index)) : null);
    }

    const applyButton = h(
      'button',
      { class: 'btn btn-small btn-primary', type: 'button', onClick: () => finish(true, '') },
      'Применить',
    );
    const rejectButton = h(
      'button',
      { class: 'btn btn-small', type: 'button', onClick: () => finish(false, '') },
      'Отклонить',
    );
    const allButton = h(
      'button',
      {
        class: 'btn btn-small',
        type: 'button',
        onClick: () => {
          const all = checks.every((box) => box.checked);
          for (const box of checks) box.checked = !all;
          syncCount();
        },
      },
      'Все / ничего',
    );

    // Вызов агента прервали — отвечать ревью больше некому, закрываем его.
    const abort = (): void => finish(false, 'отменено');
    const unregister = host.register(abort);

    /** Сколько файлов отмечено: это видно в шапке и на кнопке. */
    function syncCount(): void {
      const count = checkedIndexes().length;
      head.querySelector('.review-title')!.textContent =
        `Ассистент предлагает правки · ${files.length} ${fileWord(files.length)} · отмечено ${count}`;
      applyButton.textContent = count > 0 ? `Применить (${count})` : 'Применить';
      applyButton.disabled = count === 0;
    }
    for (const box of checks) box.addEventListener('change', syncCount);
    syncCount();

    block.appendChild(h('div', { class: 'review-actions' }, applyButton, rejectButton, allButton));
    host.mount(block);
    host.scrollToEnd();

    return decision;
  }

  return { review };
}

/** Что показать в карточке подтверждения: команда и действие в браузере отличаются только подписями. */
interface ApprovalRequest {
  /** Заголовок карточки. */
  title: string;
  /** Тело: сама команда или действие в браузере. */
  body: string;
  /** Пояснение под телом. */
  hint: string;
  /** Подпись строки итога, когда разрешили. */
  done: string;
  /** Иконка карточки и строки итога. */
  icon: IconName;
  /** Что сказала проверка модели, если она не разрешила сама. */
  review?: string;
}

export interface CommandApproval {
  /**
   * Спросить разрешение на запуск команды; `true` — выполнять.
   * `review` — причина, по которой проверка модели не разрешила команду сама.
   */
  confirm(command: string, review?: string): Promise<boolean>;
  /** Спросить разрешение на действие в браузере (переход, клик, ввод, скрипт). */
  confirmBrowser(action: string): Promise<boolean>;
}

export function createCommandApproval(host: ApprovalHost): CommandApproval {
  /** Общая карточка: рисуем, ждём нажатия, отдаём ответ обещанием. */
  function show(request: ApprovalRequest): Promise<boolean> {
    const block = h('div', { class: 'approval' });
    block.appendChild(h('div', { class: 'approval-head' }, svgIcon('warning', 13), h('span', {}, request.title)));
    block.appendChild(h('pre', { class: 'approval-command' }, request.body));
    block.appendChild(h('div', { class: 'field-hint' }, request.hint));
    // Проверка модели не решилась — её причина стоит здесь, а не в отдельном
    // уведомлении: человек читает её в тот момент, когда принимает решение.
    if (request.review) {
      block.appendChild(
        h('div', { class: 'approval-review-note' }, svgIcon('sparkle', 12), h('span', {}, request.review)),
      );
    }

    let settle: (allowed: boolean) => void = () => undefined;
    const decision = new Promise<boolean>((resolve) => {
      settle = resolve;
    });

    /** Решение принято — тело и подсказка больше не нужны: остаётся строка статуса. */
    function finish(allowed: boolean, note: string): void {
      unregister();
      block.classList.add('decision-done');
      block.replaceChildren(
        h(
          'div',
          { class: 'decision-line' },
          svgIcon(request.icon, 12),
          h('span', {}, request.done),
          note ? h('span', { class: 'decision-status' }, note) : null,
        ),
      );
      block.scrollIntoView({ block: 'nearest' });
      settle(allowed);
    }

    const runButton = h(
      'button',
      { class: 'btn btn-small btn-primary', type: 'button', onClick: () => finish(true, 'разрешено') },
      'Выполнить',
    );
    const skipButton = h(
      'button',
      { class: 'btn btn-small', type: 'button', onClick: () => finish(false, 'отменено') },
      'Отменить',
    );
    const abort = (): void => finish(false, 'отменено');
    const unregister = host.register(abort);

    block.appendChild(h('div', { class: 'approval-actions' }, runButton, skipButton));
    host.mount(block);
    host.scrollToEnd();

    return decision;
  }

  return {
    confirm: (command, review) =>
      show({
        title: 'Ассистент просит выполнить команду',
        body: command,
        hint: 'Команда выполнится в папке проекта от вашего имени.',
        done: 'Выполняется скрипт',
        icon: 'terminal',
        ...(review ? { review: `Проверка не решилась: ${review}` } : {}),
      }),
    confirmBrowser: (action) =>
      show({
        title: 'Ассистент просит действие в браузере',
        body: action,
        hint: 'Действие выполнится в отдельном браузере IDE — он не видит ваши сессии и закладки.',
        done: 'Действие в браузере',
        icon: 'search',
      }),
  };
}

/**
 * Строка ленты о том, что команду разрешила проверка модели, а не человек.
 *
 * Молча выполненное действие — это то, ради чего проверку и включают, но видеть
 * его всё равно нужно: иначе в ленте команда просто «появилась и сработала», и
 * непонятно, спрашивали ли кого-нибудь. Вид — как у закрытого решения: значок,
 * фраза и причина сбоку.
 */
export function approvalReviewNote(command: string, reason: string): HTMLElement {
  const first = command.trim().split('\n')[0] ?? '';
  const short = first.length > 80 ? `${first.slice(0, 77)}…` : first;
  return h(
    'div',
    { class: 'decision-line is-review' },
    svgIcon('sparkle', 12),
    h('span', {}, `Разрешено проверкой: ${short}`),
    h('span', { class: 'decision-status' }, reason),
  );
}

/**
 * Вопрос агента человеку (инструмент `ask`). Не решение «да/нет», а ответ текстом:
 * агент останавливается и ждёт. Отсюда и отличие от подтверждений — поле ввода и,
 * если у вопроса есть готовые варианты, кнопки с ними: один клик вместо набора.
 * Прерванный прогон закрывает карточку так же, как approval, — через `host.register`.
 */
export interface AskPrompt {
  /** Задать вопрос и дождаться ответа. Пустая строка — ответа не будет. */
  ask(question: string, options?: readonly string[]): Promise<string>;
}

export function createAskPrompt(host: ApprovalHost): AskPrompt {
  function ask(question: string, options?: readonly string[]): Promise<string> {
    const block = h('div', { class: 'ask' });
    block.appendChild(
      h('div', { class: 'approval-head' }, svgIcon('bubble', 13), h('span', {}, 'Ассистент спрашивает')),
    );
    block.appendChild(h('div', { class: 'ask-question' }, question));

    let settle: (answer: string) => void = () => undefined;
    const decision = new Promise<string>((resolve) => {
      settle = resolve;
    });

    /** Ответ принят — поле и кнопки убираем, остаётся строка итога с самим ответом. */
    function finish(answer: string): void {
      unregister();
      const text = answer.trim();
      block.classList.add('decision-done');
      block.replaceChildren(
        h(
          'div',
          { class: 'decision-line' },
          svgIcon('bubble', 12),
          h('span', {}, text ? 'Ответ отправлен ассистенту' : 'Вопрос оставлен без ответа'),
          h(
            'span',
            { class: 'decision-status' },
            text ? (text.length > 80 ? `${text.slice(0, 79)}…` : text) : 'отменено',
          ),
        ),
      );
      block.scrollIntoView({ block: 'nearest' });
      settle(text);
    }

    const input = h('input', {
      class: 'field-input',
      type: 'text',
      spellcheck: 'false',
      placeholder: 'Ваш ответ',
    }) as HTMLInputElement;

    input.addEventListener('keydown', (event) => {
      // Enter отправляет: карточка короткая, тянуться к кнопке незачем.
      if (event.key !== 'Enter') return;
      event.preventDefault();
      finish(input.value);
    });

    // Готовые варианты над полем: нажатие — это сразу ответ.
    if (options && options.length > 0) {
      const variants = h('div', { class: 'ask-options' });
      for (const option of options) {
        variants.appendChild(
          h('button', { class: 'btn btn-small', type: 'button', onClick: () => finish(option) }, option),
        );
      }
      block.appendChild(variants);
    }

    const answerButton = h(
      'button',
      { class: 'btn btn-small btn-primary', type: 'button', onClick: () => finish(input.value) },
      'Ответить',
    );
    const skipButton = h('button', { class: 'btn btn-small', type: 'button', onClick: () => finish('') }, 'Отменить');

    // Прогон прервали — отвечать больше некому, закрываем вопрос.
    const abort = (): void => finish('');
    const unregister = host.register(abort);

    block.appendChild(h('div', { class: 'ask-input' }, input));
    block.appendChild(h('div', { class: 'approval-actions' }, answerButton, skipButton));
    host.mount(block);
    host.scrollToEnd();
    input.focus();

    return decision;
  }

  return { ask };
}

/**
 * Утверждение плана (инструмент `exit_plan_mode`).
 *
 * Режим «План» — обещание «только читаю». Закончить его человек должен одним нажатием
 * здесь же, в ленте, где видит план: переключение селекта — это не ответ на план.
 * Утверждение переводит режим в «Агента» (делает панель), отказ уносит замечание
 * обратно модели — с ним она поправит план. Замечание поэтому поле карточки, а не
 * отдельный вопрос: два клика вместо одного — это уже ссора с человеком.
 */
export interface PlanApproval {
  /** Отдать план на решение. «Да» — только явное нажатие «Утвердить». */
  ask(plan: string): Promise<PlanExitDecision>;
}

export function createPlanApproval(host: ApprovalHost): PlanApproval {
  function ask(plan: string): Promise<PlanExitDecision> {
    const block = h('div', { class: 'ask plan-exit' });
    block.appendChild(
      h('div', { class: 'approval-head' }, svgIcon('checklist', 13), h('span', {}, 'План готов — утвердить?')),
    );

    const text = plan.trim();
    if (text) block.appendChild(h('div', { class: 'ask-question' }, text));

    const note = h('input', {
      class: 'field-input',
      type: 'text',
      spellcheck: 'false',
      placeholder: 'Замечание к плану (необязательно)',
    }) as HTMLInputElement;
    const noteText = (): string => note.value.trim();

    let settle: (decision: PlanExitDecision) => void = () => undefined;
    const decision = new Promise<PlanExitDecision>((resolve) => {
      settle = resolve;
    });

    /** Решение принято: карточка сворачивается в строку итога с тем, что решили. */
    function finish(approved: boolean): void {
      unregister();
      block.classList.add('decision-done');
      block.replaceChildren(
        h(
          'div',
          { class: 'decision-line' },
          svgIcon('checklist', 12),
          h('span', {}, approved ? 'План утверждён — работаю' : 'План отправлен на доработку'),
          h('span', { class: 'decision-status' }, approved ? 'режим Агент' : noteText() || 'без замечания'),
        ),
      );
      block.scrollIntoView({ block: 'nearest' });
      settle({ approved, note: approved ? '' : noteText() });
    }

    note.addEventListener('keydown', (event) => {
      // Enter — согласие, но только когда замечания нет: с замечанием человек явно
      // просит переделать, и Enter не должен читаться как «утверждаю».
      if (event.key !== 'Enter') return;
      event.preventDefault();
      finish(noteText() === '');
    });

    const approveButton = h(
      'button',
      { class: 'btn btn-small btn-primary', type: 'button', onClick: () => finish(true) },
      'Утвердить',
    );
    const reworkButton = h(
      'button',
      { class: 'btn btn-small', type: 'button', onClick: () => finish(false) },
      'Продолжить планировать',
    );

    // Прогон прервали — утверждать больше нечего: план уходит на доработку без замечаний.
    const abort = (): void => finish(false);
    const unregister = host.register(abort);

    block.appendChild(h('div', { class: 'ask-input' }, note));
    block.appendChild(h('div', { class: 'approval-actions' }, approveButton, reworkButton));
    host.mount(block);
    host.scrollToEnd();
    note.focus();

    return decision;
  }

  return { ask };
}
