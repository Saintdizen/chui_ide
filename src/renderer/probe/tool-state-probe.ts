/**
 * Страница пробы состояния вызова инструмента: рисуем ленту действий, как в чате,
 * и даём пробе рассмотреть значки состояний (галочка, крест, крутящийся круг).
 *
 * Сама лента — боевой код (`chat-tools.ts`), а не копия разметки: иначе проба
 * стерегла бы выдуманный вид, а не тот, что видит человек.
 */
import type { ToolCardView } from '../ui/chat-tools';
import { createToolFeed } from '../ui/chat-tools';

declare global {
  interface Window {
    /** Ручки пробы: состояния сменяются её вызовами. */
    probeTools: {
      feed: ReturnType<typeof createToolFeed>;
      done: ToolCardView;
      failed: ToolCardView;
      running: ToolCardView;
    };
  }
}

const root = document.getElementById('probe-root');
if (!root) throw new Error('нет #probe-root');

const feed = createToolFeed(root);

/** Три вызова: два уже отработали по-разному, один ещё идёт. */
const done = feed.add({ id: 'ok', name: 'read_file', args: '{"path":"/проект/src/app.ts"}' });
const failed = feed.add({ id: 'fail', name: 'run_terminal', args: '{"command":"npm test"}' });
const running = feed.add({ id: 'run', name: 'search', args: '{"query":"createToolFeed"}' });

done.finish({ id: 'ok', name: 'read_file', ok: true, summary: 'готово', detail: 'file' });
failed.finish({
  id: 'fail',
  name: 'run_terminal',
  ok: false,
  summary: 'Ошибка: команда завершилась с кодом 1',
  detail: 'boom',
});

// Группа свёрнута по умолчанию: раскрываем её здесь, в самой странице. Строки под
// раскрытием нужны видимыми, иначе состояние мерилось бы по скрытому узлу.
document.querySelector<HTMLElement>('.tool-group-head')?.click();

// Всё, что нужно пробе: состояния сменятся её вызовами.
window.probeTools = { feed, done, failed, running };
