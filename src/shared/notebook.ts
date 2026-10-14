/**
 * Разбор ноутбука Jupyter (`.ipynb`).
 *
 * Ноутбук — это JSON формата nbformat: список ЯЧЕЕК (markdown, код, raw) плюс метаданные.
 * Редактор показывает файл как текст (это и есть содержимое), а здесь мы выделяем из
 * него ячейки — чтобы показать их отдельно, «как их видит читатель», и чтобы уметь
 * сравнивать два ноутбука по ячейкам, а не по строкам JSON (в JSON любой сдвиг вывода
 * меняет половину файла и сравнение строк бесполезно).
 *
 * Разбор терпимый: незнакомые поля игнорируются, битый JSON и не-ноутбук дают понятную
 * ошибку, а не исключение — файл мог остаться от другой версии инструмента.
 *
 * Модуль чистый: ни диска, ни DOM. Его видно юнит-тестами, а окно лишь показывает.
 */

/** Вид ячейки, как он назван в nbformat. */
export type NotebookCellKind = 'markdown' | 'code' | 'raw';

/** Один выход исполнения кода: текст, картинка или ошибка. */
export interface NotebookOutput {
  /** Как вывод назван для показа: `text`, `error`, `image/png` и т. п. */
  kind: string;
  /** Готовый текст вывода (для картинки — её mime-тип без данных). */
  text: string;
}

/** Ячейка ноутбука в том виде, в каком её показывает окно. */
export interface NotebookCell {
  /** Порядковый номер в файле, с нуля — как в nbformat. */
  index: number;
  kind: NotebookCellKind;
  /** Исходник ячейки: строки склеены, как их пишет Jupyter. */
  source: string;
  /** Номер исполнения кода (число в `[ ]`); `null` — не исполнялась или это markdown. */
  executionCount: number | null;
  /** Что ячейка вывела (у кода). */
  outputs: NotebookOutput[];
}

export interface Notebook {
  cells: NotebookCell[];
  /** Мажор формата (`nbformat`); `null` — поля нет. */
  format: number | null;
  /** Язык ядра (`metadata.kernelspec.language`), если записан. */
  language: string | null;
  /** Что не так с файлом; `null` — разобрался. */
  error: string | null;
}

/** Путь похож на ноутбук. */
export function isNotebookPath(path: string): boolean {
  return /\.ipynb$/i.test(path);
}

/** `source` и `text` в nbformat бывают строкой или массивом строк — приводим к строке. */
function joinText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter((part): part is string => typeof part === 'string').join('');
  return '';
}

function cellKind(value: unknown): NotebookCellKind | null {
  if (value === 'markdown' || value === 'code' || value === 'raw') return value;
  return null;
}

function toOutputs(value: unknown): NotebookOutput[] {
  if (!Array.isArray(value)) return [];
  const outputs: NotebookOutput[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const output = item as Record<string, unknown>;
    const type = output.output_type;
    if (type === 'stream') {
      // У потока текст — массив строк или строка; имя потока (stdout/stderr) не важно.
      outputs.push({ kind: 'text', text: joinText(output.text) });
      continue;
    }
    if (type === 'error') {
      const name = typeof output.ename === 'string' ? output.ename : 'ошибка';
      outputs.push({ kind: 'error', text: `${name}: ${joinText(output.evalue)}` });
      continue;
    }
    if (type === 'execute_result' || type === 'display_data') {
      const data = output.data;
      if (typeof data === 'object' && data !== null) {
        const mime = Object.keys(data as Record<string, unknown>);
        // Данные картинок в окне не показываем — говорим только, что они есть.
        const image = mime.find((key) => key.startsWith('image/'));
        if (image) {
          outputs.push({ kind: image, text: '(изображение)' });
          continue;
        }
        const textKey = mime.find((key) => key === 'text/plain' || key === 'text/html');
        if (textKey) outputs.push({ kind: 'text', text: joinText((data as Record<string, unknown>)[textKey]) });
      }
    }
  }
  return outputs;
}

/**
 * Разобрать текст `.ipynb` в ячейки. Пустой `cells` — тоже ответ (ноутбук без ячеек),
 * поэтому ошибку ставим лишь тогда, когда это вовсе не ноутбук.
 */
export function parseNotebook(text: string): Notebook {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { cells: [], format: null, language: null, error: 'Это не JSON: файл не похож на ноутбук.' };
  }
  if (typeof raw !== 'object' || raw === null) {
    return { cells: [], format: null, language: null, error: 'Это не JSON: файл не похож на ноутбук.' };
  }
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.cells)) {
    return { cells: [], format: null, language: null, error: 'В файле нет списка ячеек — это не ноутбук.' };
  }

  const cells: NotebookCell[] = [];
  value.cells.forEach((item, index) => {
    if (typeof item !== 'object' || item === null) return;
    const cell = item as Record<string, unknown>;
    const kind = cellKind(cell.cell_type);
    if (!kind) return;
    const count = cell.execution_count;
    cells.push({
      index,
      kind,
      source: joinText(cell.source),
      executionCount: typeof count === 'number' ? count : null,
      outputs: kind === 'code' ? toOutputs(cell.outputs) : [],
    });
  });

  let language: string | null = null;
  const metadata = value.metadata;
  if (typeof metadata === 'object' && metadata !== null) {
    const spec = (metadata as Record<string, unknown>).kernelspec;
    if (typeof spec === 'object' && spec !== null) {
      const name = (spec as Record<string, unknown>).language;
      if (typeof name === 'string' && name !== '') language = name;
    }
  }

  return {
    cells,
    format: typeof value.nbformat === 'number' ? value.nbformat : null,
    language,
    error: null,
  };
}

/** Короткая подпись состава: «12 ячеек: 5 markdown, 7 кода». */
export function notebookSummary(notebook: Notebook): string {
  const markdown = notebook.cells.filter((cell) => cell.kind === 'markdown').length;
  const code = notebook.cells.filter((cell) => cell.kind === 'code').length;
  const raw = notebook.cells.length - markdown - code;
  const parts: string[] = [];
  if (markdown > 0) parts.push(`${markdown} markdown`);
  if (code > 0) parts.push(`${code} кода`);
  if (raw > 0) parts.push(`${raw} raw`);
  const total = `${notebook.cells.length} ${plural(notebook.cells.length, 'ячейка', 'ячейки', 'ячеек')}`;
  return parts.length > 0 ? `${total}: ${parts.join(', ')}` : total;
}

/** Русское склонение по числу: 1 ячейка, 2 ячейки, 5 ячеек. */
export function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}
