// Стартовое окно — отдельная точка входа. Monaco и xterm сюда не попадают:
// этому экрану нужен только мост RPC, поэтому он грузится мгновенно.
import './styles/fonts.css';
import './styles/theme.css';
import './styles/main.css';
import { startLauncher } from './ui/launcher';

const mount = document.getElementById('app');
if (!mount) throw new Error('Не найден контейнер #app');

void startLauncher(mount).catch((error: unknown) => {
  console.error('[chui] не удалось запустить стартовое окно', error);
  mount.textContent = 'Не удалось открыть стартовое окно';
});
