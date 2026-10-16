import { highlightInto } from '../core/highlight';
import { renderDisplayMath, renderInlineMath } from './math-view';
import { renderMermaid } from './mermaid-view';
import { type Child, h, pulseOnClick, svgIcon } from './dom';
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

/** Разобранный блок разметки и ключ-исходник, по которому узнаётся его неизменность. */
interface MarkdownBlock {
  key: string;
  node: HTMLElement;
}

export function createMarkdownRenderer(deps: MarkdownDeps): {
  renderInto(container: HTMLElement, text: string, options?: { streaming?: boolean }): void;
} {
  /**
   * Готовые узлы последнего рендера. Стрим зовёт `renderInto` каждый кадр, и без
   * этого весь ответ пересобирался бы заново — вместе с подсветкой кода, самой
   * дорогой частью. Ведущие блоки, чей исходник не изменился, переиспользуем:
   * отрисовка блока — чистая функция от исходника, поэтому тот же ключ даёт тот
   * же вид, и подмены не случится.
   */
  const rendered = new WeakMap<HTMLElement, { keys: string[]; nodes: HTMLElement[] }>();

  function renderInto(container: HTMLElement, text: string, options: { streaming?: boolean } = {}): void {
    const blocks = text ? markdownBlocks(text, options.streaming === true) : [];
    const prev = rendered.get(container);
    // Сколько ведущих блоков не изменилось: у них тот же ключ — берём готовый узел.
    let same = 0;
    if (prev) {
      while (same < blocks.length && same < prev.nodes.length && prev.keys[same] === blocks[same]!.key) same += 1;
    }
    const nodes = blocks.map((block, at) => (prev && at < same ? prev.nodes[at]! : block.node));
    // Снимаем только изменившийся хвост, а общий префикс оставляем на месте: так
    // браузер не пересобирает уже показанные блоки.
    while (container.childNodes.length > same) container.lastChild?.remove();
    for (let at = same; at < nodes.length; at += 1) container.appendChild(nodes[at]!);
    rendered.set(container, { keys: blocks.map((block) => block.key), nodes });
  }

  function markdownBlocks(text: string, streaming: boolean): MarkdownBlock[] {
    const blocks: MarkdownBlock[] = [];
    const lines = text.split('\n');
    let index = 0;

    while (index < lines.length) {
      const start = index;
      const line = lines[index] ?? '';
      // Ключ — исходник блока и режим отрисовки: у незакрытого во время стрима
      // блока кода вид другой, и переиспользовать его после закрытия нельзя.
      const emit = (node: HTMLElement, mode = ''): void => {
        blocks.push({ key: `${mode}|${lines.slice(start, index).join('\n')}`, node });
      };

      // Формула отдельным блоком: `$$…$$`, в том числе записанная в несколько строк
      // (так её пишут в заметках). Проверяем раньше забора кода: это тоже разметка.
      if (line.trimStart().startsWith('$$')) {
        const rest = line.trim().slice(2);
        const single = rest.endsWith('$$') && rest.length > 2;
        let formula = single ? rest.slice(0, -2) : rest;
        let closed = single;
        index += 1;
        while (!closed && index < lines.length) {
          const next = lines[index] ?? '';
          index += 1;
          const close = next.indexOf('$$');
          if (close >= 0) {
            formula += `\n${next.slice(0, close)}`;
            closed = true;
            break;
          }
          formula += `\n${next}`;
        }
        emit(mathNode(formula, true), 'math');
        continue;
      }

      // Блок кода: ``` с необязательным языком.
      if (line.trimStart().startsWith('```')) {
        const language = line.trim().slice(3).trim();
        const body: string[] = [];
        index += 1;
        let closed = false;
        while (index < lines.length) {
          if ((lines[index] ?? '').trimStart().startsWith('```')) {
            closed = true;
            break;
          }
          body.push(lines[index] ?? '');
          index += 1;
        }
        index += 1;
        // Во время стрима незакрытый забор — это ещё растущий блок: не тратим
        // время на подсветку, она всё равно изменится на следующем кадре.
        // Красим, как только забор закроется (или ответ закончится).
        const fence = body.join('\n');
        // Формулу в заборе рисуем как формулу: язык `latex` (он же `tex`, `math`)
        // означает, что это не код, а математика. Не разобралась — показываем кодом,
        // чтобы исходник не потерялся.
        if (isMathLanguage(language)) {
          const formula = renderDisplayMath(fence);
          if (formula) {
            emit(formula, 'math');
            continue;
          }
        }
        // Диаграмму Mermaid рисуем своим слоем: язык `mermaid`. Не разобралась —
        // показываем кодом, чтобы исходник не потерялся.
        if (isMermaidLanguage(language)) {
          const diagram = renderMermaid(fence);
          if (diagram) {
            emit(diagram, 'mermaid');
            continue;
          }
        }
        const plain = streaming && !closed;
        emit(codeBlock(fence, language, plain), plain ? 'code-plain' : 'code');
        continue;
      }

      if (!line.trim()) {
        index += 1;
        continue;
      }

      const heading = /^(#{1,4})\s+(.*)$/.exec(line);
      if (heading) {
        emit(h('div', { class: `md-heading md-h${heading[1]!.length}` }, ...inlineMarkdown(heading[2] ?? '')), 'h');
        index += 1;
        continue;
      }

      if (/^>\s?/.test(line)) {
        const body: string[] = [];
        while (index < lines.length && /^>\s?/.test(lines[index] ?? '')) {
          body.push((lines[index] ?? '').replace(/^>\s?/, ''));
          index += 1;
        }
        emit(h('blockquote', { class: 'md-quote' }, ...inlineMarkdown(body.join(' '))), 'q');
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
        emit(tableBlock(header, rows), 't');
        continue;
      }

      // Горизонтальная линия: `---`, `***` или `___` (от трёх знаков).
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        emit(h('hr', { class: 'md-hr' }), 'hr');
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
              h(
                'li',
                { class: `md-task${done ? ' is-done' : ''}` },
                taskCheckbox(done),
                ...inlineMarkdown(task[2] ?? ''),
              ),
            );
          } else {
            list.appendChild(h('li', {}, ...inlineMarkdown(itemText)));
          }
          index += 1;
        }
        emit(list, bullet ? 'ul' : 'ol');
        continue;
      }

      // Абзац: строки до пустой. Перенос внутри абзаца — мягкий, как в markdown.
      const paragraph: string[] = [];
      while (index < lines.length) {
        const next = lines[index] ?? '';
        if (!next.trim() || /^(#{1,4}\s|>|\s*[-*+]\s|\s*\d+[.)]\s)/.test(next) || next.trimStart().startsWith('```'))
          break;
        paragraph.push(next.trim());
        index += 1;
      }
      if (paragraph.length > 0) emit(h('p', { class: 'md-p' }, ...inlineMarkdown(paragraph.join(' '))), 'p');
      else index += 1;
    }

    return blocks;
  }

  /**
   * Инлайн-разметка: `код`, **жирный**, ссылки текстом и формулы `$…$`.
   *
   * Порядок разбора — от самого «закрытого» к самому простому: код, потом формула,
   * потом жирный и ссылка. Так `$` внутри кода (`ls -la $HOME`) остаётся кодом, а
   * формула внутри `\text{…}` не рвётся на части.
   */
  function inlineMarkdown(text: string): Child[] {
    const nodes: Child[] = [];
    const pattern =
      /(`[^`]+`|\$\$(?!\s)[\s\S]+?(?<!\s)\$\$|(?<![\w$])\$(?!\s)[^$\n]+?(?<!\s)\$|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
    let last = 0;

    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0;
      if (start > last) nodes.push(text.slice(last, start));

      const token = match[0];
      if (token.startsWith('`')) {
        nodes.push(inlineCode(token.slice(1, -1)));
      } else if (token.startsWith('$$')) {
        nodes.push(mathNode(token.slice(2, -2), true));
      } else if (token.startsWith('$')) {
        nodes.push(mathNode(token.slice(1, -1), false));
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
   * Формула: разобралась — рисуем узлами, нет — показываем исходник как код.
   * Молча выбросить `$\foo$` нельзя: по недорисованной формуле не понять, что было.
   */
  function mathNode(source: string, display: boolean): HTMLElement {
    const rendered = display ? renderDisplayMath(source) : renderInlineMath(source);
    if (rendered) return rendered;
    return h('code', { class: 'md-code is-math-raw', title: 'Формула не разобралась' }, source);
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
    const head = h('tr', {}, ...header.map((cell) => h('th', {}, ...inlineMarkdown(cell))));
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
  function codeBlock(code: string, language: string, plain = false): HTMLElement {
    // Действия — значки-кнопки, как под сообщением: подпись живёт в подсказке, ряд не шумит.
    const copyButton = h(
      'button',
      {
        class: 'icon-btn',
        type: 'button',
        title: 'Копировать',
        'aria-label': 'Копировать',
        onClick: () => {
          void navigator.clipboard.writeText(code).then(
            () => showToast('Скопировано'),
            () => showToast('Не удалось скопировать', 'error'),
          );
        },
      },
      svgIcon('copy', 14),
    );
    const insertButton = h(
      'button',
      {
        class: 'icon-btn',
        type: 'button',
        title: 'Вставить в позицию курсора',
        'aria-label': 'Вставить в позицию курсора',
        onClick: () => {
          if (deps.insertCode(code)) showToast('Вставлено в позицию курсора');
          else showToast('Нет открытого редактора', 'error');
        },
      },
      svgIcon('paste', 14),
    );
    // Копирование и вставка вид кнопки не меняют — нажатие подтверждаем пульсом.
    pulseOnClick(copyButton);
    pulseOnClick(insertButton);
    const bar = h(
      'div',
      { class: 'code-bar' },
      h('span', { class: 'code-lang' }, language || 'text'),
      copyButton,
      insertButton,
    );

    return h(
      'div',
      { class: 'code-block' },
      bar,
      h('pre', {}, language === 'diff' ? diffNode(code) : plain ? plainCode(code) : codeNode(code, language)),
    );
  }

  /** Незакрытый во время стрима блок: текст без подсветки — она ещё изменится. */
  function plainCode(code: string): HTMLElement {
    const node = h('code', {});
    node.textContent = code;
    return node;
  }

  /** Диффом модель отвечает часто: + / − красим сами. */
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

  /** Блок кода: текст сразу, цвета — как отдаст подсветка. */
  function codeNode(code: string, language: string): HTMLElement {
    const node = h('code', {});
    highlightInto(node, code, language);
    return node;
  }

  /** Язык забора, которым пишут формулу, а не код. */
  function isMathLanguage(language: string): boolean {
    return ['latex', 'tex', 'math'].includes(language.trim().toLowerCase());
  }

  /** Язык забора, которым пишут диаграмму Mermaid. */
  function isMermaidLanguage(language: string): boolean {
    const name = language.trim().toLowerCase();
    return name === 'mermaid' || name === 'mmd';
  }

  return { renderInto };
}
