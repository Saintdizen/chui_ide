import { highlightInto } from '../core/highlight';
import { type Child, clear, h } from './dom';
import { showToast } from './toast';

/**
 * Компактный markdown для ленты чата: заголовки, списки, цитаты, таблицы,
 * чек-листы, блоки кода и инлайн-разметка. Никакого innerHTML — узлы создаются
 * напрямую, поэтому ответ модели не может вставить разметку в интерфейс.
 *
 * Вынесено из `chat.ts`: панель занимается разговором, а разбор текста — здесь.
 * Единственная внешняя зависимость — вставка кода в редактор, её передают сюда.
 */
export interface MarkdownDeps {
  /** Вставка кода в позицию курсора; `false` — открытого редактора нет. */
  insertCode(code: string): boolean;
}

export function createMarkdownRenderer(deps: MarkdownDeps): {
  renderInto(container: HTMLElement, text: string): void;
} {
  function renderInto(container: HTMLElement, text: string): void {
    clear(container);
    if (!text) return;
    for (const node of markdownBlocks(text)) container.appendChild(node);
  }

  function markdownBlocks(text: string): HTMLElement[] {
    const nodes: HTMLElement[] = [];
    const lines = text.split('\n');
    let index = 0;

    while (index < lines.length) {
      const line = lines[index] ?? '';

      // Блок кода: ``` с необязательным языком.
      if (line.trimStart().startsWith('```')) {
        const language = line.trim().slice(3).trim();
        const body: string[] = [];
        index += 1;
        while (index < lines.length && !(lines[index] ?? '').trimStart().startsWith('```')) {
          body.push(lines[index] ?? '');
          index += 1;
        }
        index += 1;
        nodes.push(codeBlock(body.join('\n'), language));
        continue;
      }

      if (!line.trim()) {
        index += 1;
        continue;
      }

      const heading = /^(#{1,4})\s+(.*)$/.exec(line);
      if (heading) {
        nodes.push(h('div', { class: `md-heading md-h${heading[1]!.length}` }, ...inlineMarkdown(heading[2] ?? '')));
        index += 1;
        continue;
      }

      if (/^>\s?/.test(line)) {
        const body: string[] = [];
        while (index < lines.length && /^>\s?/.test(lines[index] ?? '')) {
          body.push((lines[index] ?? '').replace(/^>\s?/, ''));
          index += 1;
        }
        nodes.push(h('blockquote', { class: 'md-quote' }, ...inlineMarkdown(body.join(' '))));
        continue;
      }

      // Таблица: строка с `|` и следом строка-разделитель из дефисов.
      if (line.includes('|') && isTableSeparator(lines[index + 1] ?? '')) {
        const header = splitRow(line);
        const rows: string[][] = [];
        index += 2;
        while (index < lines.length && (lines[index] ?? '').includes('|') && (lines[index] ?? '').trim()) {
          rows.push(splitRow(lines[index] ?? ''));
          index += 1;
        }
        nodes.push(tableBlock(header, rows));
        continue;
      }

      // Горизонтальная линия: `---`, `***` или `___` (от трёх знаков).
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        nodes.push(h('hr', { class: 'md-hr' }));
        index += 1;
        continue;
      }

      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
      const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (bullet || ordered) {
        const list = h(bullet ? 'ul' : 'ol', { class: 'md-list' });
        while (index < lines.length) {
          const match = (bullet ? /^\s*[-*+]\s+(.*)$/ : /^\s*\d+[.)]\s+(.*)$/).exec(lines[index] ?? '');
          if (!match) break;
          const itemText = match[1] ?? '';
          // Чек-лист `- [x] готово`: рисуем с чекбоксом, а не как обычный пункт.
          const task = /^\[([ xX])\]\s+(.*)$/.exec(itemText);
          if (task) {
            const done = task[1]!.toLowerCase() === 'x';
            list.appendChild(
              h('li', { class: `md-task${done ? ' is-done' : ''}` }, taskCheckbox(done), ...inlineMarkdown(task[2] ?? '')),
            );
          } else {
            list.appendChild(h('li', {}, ...inlineMarkdown(itemText)));
          }
          index += 1;
        }
        nodes.push(list);
        continue;
      }

      // Абзац: строки до пустой. Перенос внутри абзаца — мягкий, как в markdown.
      const paragraph: string[] = [];
      while (index < lines.length) {
        const next = lines[index] ?? '';
        if (!next.trim() || /^(#{1,4}\s|>|\s*[-*+]\s|\s*\d+[.)]\s)/.test(next) || next.trimStart().startsWith('```')) break;
        paragraph.push(next.trim());
        index += 1;
      }
      if (paragraph.length > 0) nodes.push(h('p', { class: 'md-p' }, ...inlineMarkdown(paragraph.join(' '))));
      else index += 1;
    }

    return nodes;
  }

  /** Инлайн-разметка: `код`, **жирный** и ссылки в виде текста с подсказкой. */
  function inlineMarkdown(text: string): Child[] {
    const nodes: Child[] = [];
    const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
    let last = 0;

    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0;
      if (start > last) nodes.push(text.slice(last, start));

      const token = match[0];
      if (token.startsWith('`')) {
        nodes.push(inlineCode(token.slice(1, -1)));
      } else if (token.startsWith('**')) {
        nodes.push(h('strong', {}, token.slice(2, -2)));
      } else {
        const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
        if (link) nodes.push(h('span', { class: 'md-link', title: link[2] ?? '' }, link[1] ?? ''));
      }

      last = start + token.length;
    }

    if (last < text.length) nodes.push(text.slice(last));
    return nodes;
  }

  /**
   * Инлайн-код красим теми же токенами, что и блоки кода. Язык у фрагмента не
   * указан, поэтому угадываем по виду: команда оболочки, Python или (по умолчанию)
   * JavaScript — он же покрывает TS: имена, свойства и вызовы читаются как надо.
   */
  function inlineCode(code: string): HTMLElement {
    const node = h('code', { class: 'md-code' });
    highlightInto(node, code, guessInlineLanguage(code));
    return node;
  }

  function guessInlineLanguage(code: string): string {
    const text = code.trim();
    if (
      /^(\$|npm|npx|yarn|pnpm|git|cd|ls|rm|mkdir|touch|echo|cat|grep|sed|awk|curl|wget|pip|pip3|make|node|sudo|chmod)\b/.test(
        text,
      ) ||
      text.includes(' && ')
    ) {
      return 'shell';
    }
    if (/^(def |class |import |from |return|await |async def |self\b|print\()/.test(text) || /\bself\./.test(text)) {
      return 'python';
    }
    return 'javascript';
  }

  /** Ячейки строки таблицы: внешние разделители и пустые края отбрасываем. */
  function splitRow(line: string): string[] {
    return line
      .replace(/^\s*\|/, '')
      .replace(/\|\s*$/, '')
      .split('|')
      .map((cell) => cell.trim());
  }

  /** Строка-разделитель таблицы: `--- | :---: | ---`. */
  function isTableSeparator(line: string): boolean {
    return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');
  }

  /** Таблица markdown: узлы создаются напрямую, без innerHTML. */
  function tableBlock(header: string[], rows: string[][]): HTMLElement {
    const head = h(
      'tr',
      {},
      ...header.map((cell) => h('th', {}, ...inlineMarkdown(cell))),
    );
    const body = h('tbody', {});
    for (const row of rows) {
      body.appendChild(h('tr', {}, ...row.map((cell) => h('td', {}, ...inlineMarkdown(cell)))));
    }
    return h('table', { class: 'md-table' }, h('thead', {}, head), body);
  }

  /** Чекбокс чек-листа: только для вида, нажатие ничего не делает. */
  function taskCheckbox(done: boolean): HTMLInputElement {
    const box = h('input', { class: 'md-check', type: 'checkbox', tabindex: '-1' });
    box.checked = done;
    box.disabled = true;
    return box;
  }

  /** Блок кода с действиями: без них ответ переносят руками. */
  function codeBlock(code: string, language: string): HTMLElement {
    const bar = h(
      'div',
      { class: 'code-bar' },
      h('span', { class: 'code-lang' }, language || 'text'),
      h(
        'button',
        {
          class: 'link-btn code-action',
          type: 'button',
          onClick: () => {
            void navigator.clipboard.writeText(code).then(
              () => showToast('Скопировано'),
              () => showToast('Не удалось скопировать', 'error'),
            );
          },
        },
        'Копировать',
      ),
      h(
        'button',
        {
          class: 'link-btn code-action',
          type: 'button',
          onClick: () => {
            if (deps.insertCode(code)) showToast('Вставлено в позицию курсора');
            else showToast('Нет открытого редактора', 'error');
          },
        },
        'Вставить',
      ),
    );

    return h('div', { class: 'code-block' }, bar, h('pre', {}, language === 'diff' ? diffNode(code) : codeNode(code, language)));
  }

  /** Диффом модель отвечает часто: + / − красим сами, Monaco его так не размечает. */
  function diffNode(code: string): HTMLElement {
    const wrap = h('code', { class: 'diff-code' });
    for (const line of code.split('\n')) {
      let cls = '';
      if (/^\+/.test(line) && !/^\+\+\+/.test(line)) cls = 'diff-add';
      else if (/^-/.test(line) && !/^---/.test(line)) cls = 'diff-del';
      else if (/^@@/.test(line)) cls = 'diff-hunk';
      wrap.appendChild(h('span', { class: `diff-line ${cls}`.trim() }, line));
    }
    return wrap;
  }

  /** Блок кода: текст сразу, цвета — как отдаст Monaco. */
  function codeNode(code: string, language: string): HTMLElement {
    const node = h('code', {});
    highlightInto(node, code, language);
    return node;
  }

  return { renderInto };
}
