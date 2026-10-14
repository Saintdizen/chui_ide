import {
  literalTemplate,
  parseTemplate,
  structuralFind,
  structuralReplaceEdit,
  type StructuralMatch,
} from '../../shared/structural-search';
import { clear, h, svgIcon } from './dom';
import { showToast } from './toast';

export interface StructuralSearchDeps {
  /** Текст активного файла (в редакторе — с несохранёнными правками). `null` — файла нет. */
  activeText(): string | null;
  /** Выделение редактора: из него берётся образец, если нажать «Из выделения». */
  selectionText(): string;
  /**
   * Применить замену одним шагом истории. `start`/`end` — смещения в тексте файла,
   * `inserted` — чем заменить участок. `false` — применить не удалось.
   */
  apply(edit: { start: number; end: number; inserted: string }): Promise<boolean> | boolean;
}

export interface StructuralSearchView {
  element: HTMLElement;
  open(): void;
  close(): void;
}

/** Пауза перед пересчётом: на каждое нажатие искать по файлу не нужно. */
const DEBOUNCE = 150;

/** Сколько совпадений показывать списком: остальные — только числом. */
const MAX_SHOWN = 100;

/**
 * Поиск и замена по структуре кода — окно поверх редактора.
 *
 * Поля простые: образец и замена. Образец пишется как код, только вместо «чего угодно»
 * ставят `$имя` (один кусок) или `$имя...` (последовательность). Поэтому `foo($x, $y)`
 * находит вызов `foo` с двумя доводами, как бы те ни были записаны в исходнике.
 *
 * Почему окно, а не панель: этим пользуются редко и точечно — привести один вид записи
 * к другому по всему файлу. Держать такое постоянно на виду незачем, а кнопка «Из
 * выделения» делает образец из того, что человек уже выделил.
 */
export function createStructuralSearch(deps: StructuralSearchDeps): StructuralSearchView {
  let timer: number | null = null;

  const patternInput = h('input', {
    class: 'field-input structural-pattern',
    type: 'text',
    spellcheck: 'false',
    placeholder: 'образец: foo($x, $y)',
  });
  const replacementInput = h('input', {
    class: 'field-input structural-replacement',
    type: 'text',
    spellcheck: 'false',
    placeholder: 'замена: bar($y, $x)',
  });
  const fromSelectionButton = h(
    'button',
    { class: 'btn btn-small', type: 'button', title: 'Взять образец из выделения редактора' },
    'Из выделения',
  );

  const status = h('div', { class: 'structural-status' });
  const matchesBox = h('div', { class: 'structural-matches' });
  const applyButton = h('button', { class: 'btn btn-primary', type: 'button' }, 'Заменить всё в файле');

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
      {
        class: 'modal structural-modal',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': 'Замена по структуре кода',
      },
      h(
        'header',
        { class: 'modal-header' },
        h('span', { class: 'modal-title' }, 'Замена по структуре кода'),
        closeButton,
      ),
      h(
        'div',
        { class: 'modal-body structural-body' },
        h(
          'div',
          { class: 'structural-form' },
          h('div', { class: 'field-label' }, 'Образец'),
          patternInput,
          h('div', { class: 'field-label' }, 'Замена'),
          h('div', { class: 'structural-replace-row' }, replacementInput, fromSelectionButton),
          h(
            'p',
            { class: 'field-hint' },
            'В образце: $имя — любой один кусок, $имя... — любая последовательность, $$ — знак доллара. ' +
              'В замене те же $имя подставляются на место пойманного.',
          ),
        ),
        h('div', { class: 'structural-output' }, status, matchesBox),
      ),
      h('footer', { class: 'modal-footer' }, applyButton),
    ),
  );

  const report = (text: string, error = false): void => {
    status.textContent = text;
    status.classList.toggle('is-error', error);
  };

  function renderMatches(matches: readonly StructuralMatch[]): void {
    clear(matchesBox);
    for (const match of matches.slice(0, MAX_SHOWN)) {
      const captured = Object.entries(match.captures)
        .map(([name, value]) => `$${name} = ${flatten(value)}`)
        .join('   ');
      matchesBox.appendChild(
        h(
          'div',
          { class: 'structural-match' },
          h('code', { class: 'structural-match-text' }, flatten(match.text)),
          captured ? h('span', { class: 'structural-match-captures' }, captured) : null,
        ),
      );
    }
    if (matches.length > MAX_SHOWN) {
      matchesBox.appendChild(h('div', { class: 'structural-more' }, `…и ещё ${matches.length - MAX_SHOWN}`));
    }
  }

  function compute(): void {
    const text = deps.activeText();
    if (text === null) {
      report('Файл не открыт: заменять нечего.');
      clear(matchesBox);
      applyButton.disabled = true;
      return;
    }
    const template = parseTemplate(patternInput.value);
    if (template.error) {
      report(template.error);
      clear(matchesBox);
      applyButton.disabled = true;
      return;
    }
    const matches = structuralFind(text, template);
    if (matches.length === 0) {
      report('Совпадений нет.');
      clear(matchesBox);
      applyButton.disabled = true;
      return;
    }
    report(`Совпадений: ${matches.length}`);
    renderMatches(matches);
    applyButton.disabled = false;
  }

  function schedule(): void {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      compute();
    }, DEBOUNCE);
  }

  async function apply(): Promise<void> {
    const text = deps.activeText();
    if (text === null) return;
    const template = parseTemplate(patternInput.value);
    if (template.error) return;
    const edit = structuralReplaceEdit(text, template, replacementInput.value);
    if (!edit) {
      report('Совпадений нет.');
      return;
    }
    applyButton.disabled = true;
    const ok = await deps.apply({ start: edit.start, end: edit.end, inserted: edit.inserted });
    applyButton.disabled = false;
    if (ok) showToast(`Заменено по структуре: ${edit.count}`, 'success');
    else showToast('Замена не применена', 'error');
    compute();
  }

  patternInput.addEventListener('input', schedule);
  replacementInput.addEventListener('input', schedule);
  applyButton.addEventListener('click', () => void apply());
  fromSelectionButton.addEventListener('click', () => {
    const selection = deps.selectionText().trim();
    if (selection === '') {
      showToast('В редакторе ничего не выделено', 'info');
      return;
    }
    patternInput.value = literalTemplate(selection);
    compute();
  });

  function close(): void {
    element.hidden = true;
    document.removeEventListener('keydown', onKeyDown, true);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    close();
  }

  element.addEventListener('pointerdown', (event) => {
    if (event.target === element) close();
  });

  return {
    element,
    close,
    open() {
      compute();
      element.hidden = false;
      // Слушаем в capture и позже текущего клика: иначе Esc сработает на открытии.
      document.removeEventListener('keydown', onKeyDown, true);
      window.setTimeout(() => document.addEventListener('keydown', onKeyDown, true), 0);
      patternInput.focus();
      patternInput.select();
    },
  };
}

/** Однострочный вид куска: длинные и многострочные совпадения в списке не помещаются. */
function flatten(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 77)}…` : flat;
}
