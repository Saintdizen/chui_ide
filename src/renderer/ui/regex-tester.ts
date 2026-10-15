import {
  type RegexMatch,
  REGEX_FLAG_INFO,
  REGEX_FLAG_ORDER,
  type RegexFlagChar,
  defaultFlags,
  flagsFromString,
  flagsToString,
  replaceRegex,
  runRegex,
  toggleFlag,
} from '../../shared/regex-tester';
import { clear, h } from './dom';
import { createModal } from './modal';

export interface RegexTesterDeps {
  /**
   * Стартовый текст для поля — обычно выделение редактора. Пусто — поле оставляем
   * как есть, чтобы не затирать то, что человек уже набрал.
   */
  initialText?(): string;
}

export interface RegexTesterView {
  element: HTMLElement;
  /** Показать окно: поле текста подставляется из `initialText`, если оно пусто. */
  open(): void;
  close(): void;
}

/** Пауза перед пересчётом: на большом тексте незачем считать на каждое нажатие. */
const DEBOUNCE = 120;

/**
 * Отладчик регулярных выражений — окно поверх редактора.
 *
 * Слева поля (шаблон, флаги, текст, замена), справа ответ: где нашлось, что
 * захватили группы и что выйдет после замены. Считает всё `shared/regex-tester.ts`
 * тем же движком, что и рантайм, — окно лишь показывает.
 *
 * Почему окно, а не панель: сюда приходят с конкретным шаблоном в голове и уходят,
 * как только он заработал. Постоянная панель внизу отнимала бы место у текста ради
 * инструмента, который нужен минутами.
 */
export function createRegexTester(deps: RegexTesterDeps = {}): RegexTesterView {
  let flags = defaultFlags();
  let timer: number | null = null;

  const patternInput = h('input', {
    class: 'field-input regex-pattern',
    type: 'text',
    spellcheck: 'false',
    placeholder: 'шаблон',
  });
  const flagsInput = h('input', {
    class: 'field-input regex-flags',
    type: 'text',
    spellcheck: 'false',
    placeholder: 'gi',
  });
  const textArea = h('textarea', {
    class: 'regex-text',
    spellcheck: 'false',
    placeholder: 'Текст, в котором ищем',
  });
  const replacementInput = h('input', {
    class: 'field-input regex-replacement',
    type: 'text',
    spellcheck: 'false',
    placeholder: 'Замена: $1, $<имя>, $&',
  });

  const flagRow = h('div', { class: 'regex-flag-row' });
  const status = h('div', { class: 'regex-status' });
  const preview = h('pre', { class: 'regex-preview' });
  const matchList = h('div', { class: 'regex-matches' });
  const replacedBox = h('div', { class: 'regex-replaced', hidden: true });

  const form = h(
    'div',
    { class: 'regex-form' },
    h('div', { class: 'field-label' }, 'Шаблон и флаги'),
    h(
      'div',
      { class: 'regex-pattern-row' },
      h('span', { class: 'regex-slash' }, '/'),
      patternInput,
      h('span', { class: 'regex-slash' }, '/'),
      flagsInput,
    ),
    flagRow,
    h('div', { class: 'field-label' }, 'Текст'),
    textArea,
    h('div', { class: 'field-label' }, 'Замена (проверка, в файл не пишется)'),
    replacementInput,
  );

  const output = h('div', { class: 'regex-output' }, status, preview, replacedBox, matchList);

  const modal = createModal({ className: 'regex-modal', title: 'Отладчик регулярных выражений' });
  modal.body.classList.add('regex-body');
  modal.body.append(form, output);

  // Чипы флагов: клик переключает, подсказка объясняет — как в литерале, но нагляднее.
  const flagButtons = new Map<RegexFlagChar, HTMLButtonElement>();
  for (const char of REGEX_FLAG_ORDER) {
    const info = REGEX_FLAG_INFO[char];
    const button = h(
      'button',
      {
        class: 'regex-flag',
        type: 'button',
        title: info.hint,
        onClick: () => {
          flags = toggleFlag(flags, char);
          flagsInput.value = flagsToString(flags);
          paintFlags();
          schedule();
        },
      },
      h('span', { class: 'regex-flag-char' }, char),
      h('span', { class: 'regex-flag-label' }, info.label),
    );
    flagButtons.set(char, button);
    flagRow.appendChild(button);
  }

  /** Раскрасить чипы под текущий набор флагов (поле ввода не трогаем). */
  function paintFlags(): void {
    for (const [char, button] of flagButtons) button.classList.toggle('is-on', flags[char]);
  }

  /** Показать текст как есть — когда считать нечего (пустой шаблон, ошибка). */
  function plainPreview(text: string): void {
    clear(preview);
    preview.textContent = text;
  }

  /** Разложить текст на куски: между метками — обычный текст, в метках — совпадения. */
  function renderPreview(text: string, matches: RegexMatch[]): void {
    clear(preview);
    let cursor = 0;
    matches.forEach((match, index) => {
      if (match.start > cursor) preview.appendChild(document.createTextNode(text.slice(cursor, match.start)));
      const mark = h('mark', { class: index % 2 === 1 ? 'regex-hit is-alt' : 'regex-hit' });
      if (match.end > match.start) mark.textContent = text.slice(match.start, match.end);
      else mark.classList.add('is-empty');
      preview.appendChild(mark);
      cursor = Math.max(cursor, match.end);
    });
    if (cursor < text.length) preview.appendChild(document.createTextNode(text.slice(cursor)));
  }

  function renderMatches(matches: RegexMatch[]): void {
    clear(matchList);
    for (const match of matches) {
      const row = h(
        'div',
        { class: 'regex-match' },
        h(
          'div',
          { class: 'regex-match-head' },
          h('span', { class: 'regex-match-no' }, `#${match.order}`),
          h('span', { class: 'regex-match-range' }, `${match.start}–${match.end}`),
          h('code', { class: 'regex-match-text' }, match.text === '' ? '(пусто)' : match.text),
        ),
      );
      // Группа 0 — всё совпадение, её уже показывает строка выше.
      for (const group of match.groups.slice(1)) {
        row.appendChild(
          h(
            'div',
            { class: 'regex-group' },
            h('span', { class: 'regex-group-name' }, group.name ? `$<${group.name}>` : `$${group.number}`),
            h('code', { class: 'regex-group-text' }, group.text === undefined ? '—' : group.text),
          ),
        );
      }
      matchList.appendChild(row);
    }
  }

  function renderReplacement(pattern: string, text: string): void {
    clear(replacedBox);
    if (replacementInput.value === '') {
      replacedBox.hidden = true;
      return;
    }
    const result = replaceRegex(pattern, flags, text, replacementInput.value);
    if (!result.ok) {
      replacedBox.hidden = true;
      return;
    }
    replacedBox.hidden = false;
    replacedBox.appendChild(
      h(
        'div',
        { class: 'field-label' },
        `Результат замены — ${result.count} ${plural(result.count, 'замена', 'замены', 'замен')}`,
      ),
    );
    replacedBox.appendChild(h('pre', { class: 'regex-replaced-text' }, result.text));
  }

  function compute(): void {
    const pattern = patternInput.value;
    const text = textArea.value;

    if (pattern === '') {
      status.textContent = 'Введите шаблон';
      status.classList.remove('is-error');
      plainPreview(text);
      clear(matchList);
      clear(replacedBox);
      replacedBox.hidden = true;
      return;
    }

    const result = runRegex(pattern, flags, text);
    if (!result.ok) {
      status.textContent = result.error ?? 'Шаблон не собирается';
      status.classList.add('is-error');
      plainPreview(text);
      clear(matchList);
      clear(replacedBox);
      replacedBox.hidden = true;
      return;
    }

    status.classList.remove('is-error');
    const count = result.matches.length;
    status.textContent =
      count === 0
        ? 'Совпадений нет'
        : `${count} ${plural(count, 'совпадение', 'совпадения', 'совпадений')}${
            result.truncated ? ' — список обрезан' : ''
          }`;
    renderPreview(text, result.matches);
    renderMatches(result.matches);
    renderReplacement(pattern, text);
  }

  function schedule(): void {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      compute();
    }, DEBOUNCE);
  }

  patternInput.addEventListener('input', schedule);
  textArea.addEventListener('input', schedule);
  replacementInput.addEventListener('input', schedule);
  flagsInput.addEventListener('input', () => {
    flags = flagsFromString(flagsInput.value);
    paintFlags();
    schedule();
  });

  function close(): void {
    modal.close();
  }

  return {
    element: modal.element,
    open() {
      const seed = deps.initialText?.() ?? '';
      if (textArea.value === '' && seed !== '') textArea.value = seed;
      flagsInput.value = flagsToString(flags);
      paintFlags();
      compute();
      modal.open(patternInput);
      patternInput.select();
    },
    close,
  };
}

/** Русское склонение по числу: 1 совпадение, 2 совпадения, 5 совпадений. */
function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}
