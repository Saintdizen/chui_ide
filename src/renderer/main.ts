// Сначала палитра, потом стили: main.css читает только токены темы.
import './styles/fonts.css';
import './styles/theme.css';
import './styles/main.css';
// Свой редактор: классы `own-editor*` изолированы от остальной разметки.
import './styles/editor.css';
// Свой терминал: классы `own-term*` — по тому же правилу.
import './styles/terminal.css';
import { startApplication } from './app';

const mount = document.getElementById('app');
if (!mount) throw new Error('Не найден контейнер #app');

void startApplication(mount).catch((error: unknown) => {
  console.error('[chui] не удалось запустить приложение', error);
  const message = error instanceof Error ? error.message : String(error);
  mount.textContent = `Не удалось запустить приложение: ${message}`;
});
