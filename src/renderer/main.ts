// Сначала палитра, потом стили: main.css читает только токены темы.
import './styles/fonts.css';
import './styles/theme.css';
import './styles/main.css';
// Свой редактор: классы `own-editor*` изолированы от остальной разметки.
import './styles/editor.css';
// Свой терминал: классы `own-term*` — по тому же правилу.
import './styles/terminal.css';
import { enablePerf, perf, perfBaselineFrom, perfEnabled } from '../shared/perf';
import { startApplication } from './app';

const mount = document.getElementById('app');
if (!mount) throw new Error('Не найден контейнер #app');

// Замеры включаются адресом (`?perf=1`) или флагом в localStorage: в обычной
// работе они не стоят ничего — ни вызова `performance.now()`, ни памяти.
const perfOn = perfEnabled(new URLSearchParams(location.search).get('perf') ?? localStorage.getItem('chui:perf'));
enablePerf(perfOn);
perf.begin('app:boot');
if (perfOn) {
  // Снимок для отчёта: в DevTools `__chuiPerf()` отдаёт JSON.
  (window as unknown as Record<string, unknown>).__chuiPerf = () =>
    JSON.stringify(perfBaselineFrom(perf.spans()), null, 2);
}

void startApplication(mount)
  .then(() => {
    // Смонтировано — это нарисованный кадр, а не решённый промис: два rAF
    // дают ровно один кадр, первый срабатывает до отрисовки.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const span = perf.end('app:boot');
        if (perfOn && span) console.info('[perf]', span.phase, Math.round(span.ms), 'мс');
      }),
    );
  })
  .catch((error: unknown) => {
    console.error('[chui] не удалось запустить приложение', error);
    const message = error instanceof Error ? error.message : String(error);
    mount.textContent = `Не удалось запустить приложение: ${message}`;
  });
