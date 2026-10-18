/**
 * Страница пробы своего терминала: рисуем настоящий движок (`terminal/core` +
 * `terminal/view`) и даём пробе рассмотреть сетку, цвета, широкие знаки, лигатуры,
 * выделение, мышь и поиск.
 *
 * Движок здесь боевой, а не копия разметки: иначе проба стерегла бы выдуманный вид,
 * а не тот, что видит человек. Проба приносит свой размер контейнера, движок подгоняет
 * под него сетку — ровно как в панели (`ui/terminal.ts`).
 */
import { Terminal } from '../terminal/core/screen';
import { searchBuffer, stepMatch } from '../terminal/core/search';
import { TermView } from '../terminal/view/term-view';

declare global {
  interface Window {
    /** Ручки пробы: сетка, вид и смена схемы/лигатур по вызову. */
    probeTerm: {
      term: Terminal;
      view: TermView;
      container: HTMLElement;
      /** События мыши, которые вид отдал наружу (как их отправил бы панель в pty). */
      mouseEvents: unknown[];
      /** Поиск по ленте: количество найденного и причина ошибки запроса. */
      find(query: string): { count: number; error: string | null };
      /** Шаг к следующему (+1) или предыдущему (−1) совпадению. */
      findStep(step: number): number;
      clearFind(): void;
      /** Показать образец с гиперссылками (OSC 8) — проба смотрит на них. */
      showLinks(): void;
      refreshTheme(): void;
      setLigatures(on: boolean): void;
    };
  }
}

const root = document.getElementById('probe-root');
if (!root) throw new Error('нет #probe-root');

// Полотно консоли занимает всю страницу пробы: так вид получает настоящий размер.
const container = document.createElement('div');
container.style.cssText = 'width: 100%; height: 100%;';
root.append(container);

const term = new Terminal(80, 24);
const mouseEvents: unknown[] = [];
const view = new TermView(container, term, {
  ligatures: false,
  onMouse: (event) => mouseEvents.push(event),
});

// Подгоняем сетку под полотно и только потом печатаем: иначе пример не влез бы.
const size = view.fit();
if (size) term.resize(size.cols, size.rows);

/** Пример вывода: цвета, начертания, широкие знаки, подобие приглашения и лигатуры. */
const SAMPLE = [
  '\x1b[1;32mжирный зелёный\x1b[0m  \x1b[31mкрасный\x1b[0m  \x1b[38;5;208m256-цвет\x1b[0m  \x1b[38;2;10;120;200mtruecolor\x1b[0m',
  '\x1b[4mподчёркивание\x1b[24m  \x1b[7mобратные цвета\x1b[27m  \x1b[3mкурсив\x1b[23m',
  'широкие знаки: 日本語 你好 😀 — они держат две клетки',
  'лигатуры: => != -> <= >= ===',
  'dethjob@host:~$ echo готово',
  'готово',
].join('\r\n');

term.write(`${SAMPLE}\r\n`);
view.render();
view.stickToBottom();
// Фокус — часть вида: без него курсор скрыт (`renderCursor`). Пробе он нужен видимым.
view.focus();

// Запрос и номер текущего совпадения помним: панель поиска держит их так же.
let lastQuery = '';
let currentIndex = 0;

/** Прогнать поиск по ленте: тот же путь, что у панели поиска. */
function find(query: string): { count: number; error: string | null } {
  lastQuery = query;
  currentIndex = 0;
  const result = searchBuffer((row) => view.lineText(row), view.bufferRows(), query);
  if (result.matches.length > 0) view.showSearch(result.matches, 0);
  else view.clearSearch();
  return { count: result.matches.length, error: result.error };
}

/** Шаг к следующему совпадению — как Enter в панели поиска. */
function findStep(step: number): number {
  const result = searchBuffer((row) => view.lineText(row), view.bufferRows(), lastQuery);
  if (result.matches.length === 0) return -1;
  currentIndex = stepMatch(currentIndex, result.matches.length, step);
  view.showSearch(result.matches, currentIndex);
  return currentIndex;
}

/** Образец с гиперссылкой (OSC 8) и именем окна (OSC 2) — для пробы. */
function showLinks(): void {
  term.write('\x1b]2;пример ссылок\x07');
  term.write('\x1b[2J\x1b[H');
  term.write('ссылка: \x1b]8;;https://example.com\x07example.com\x1b]8;;\x07 конец\r\n');
  view.render();
  view.stickToBottom();
}

window.probeTerm = {
  term,
  view,
  container,
  mouseEvents,
  find,
  findStep,
  clearFind: () => view.clearSearch(),
  showLinks,
  refreshTheme: () => view.refreshTheme(),
  setLigatures: (on) => view.setLigatures(on),
};
