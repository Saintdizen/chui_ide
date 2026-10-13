/**
 * Страница пробы своего терминала: рисуем настоящий движок (`terminal/core` +
 * `terminal/view`) и даём пробе рассмотреть сетку, цвета, широкие знаки и лигатуры.
 *
 * Движок здесь боевой, а не копия разметки: иначе проба стерегла бы выдуманный вид,
 * а не тот, что видит человек. Проба приносит свой размер контейнера, движок подгоняет
 * под него сетку — ровно как в панели (`ui/terminal.ts`).
 */
import { Terminal } from '../terminal/core/screen';
import type { Scheme } from '../core/theme';
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
      setScheme(scheme: Scheme): void;
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
  scheme: 'dark',
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
// Фокус — часть вида: без него курсор скрыт (`renderCursor`). Пробе он нужен видимым.
view.focus();

window.probeTerm = {
  term,
  view,
  container,
  mouseEvents,
  setScheme: (scheme) => view.setScheme(scheme),
  setLigatures: (on) => view.setLigatures(on),
};
