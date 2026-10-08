// Русские строки редактора: пакет языков лежит внутри самой Monaco
// (`monaco-editor/nls/lang/ru.js`) и наполняет глобальную таблицу
// `_VSCODE_NLS_MESSAGES`, откуда библиотека берёт подписи контекстного меню,
// палитры (F1), поиска и подсказок. Импорт обязан идти до `./app`: подписи
// действий читаются при загрузке модулей Monaco, а не при первом показе.
import 'monaco-editor/nls/lang/ru.js';
// Сначала палитра, потом стили: main.css читает только токены темы.
import './styles/fonts.css';
import './styles/theme.css';
import './styles/main.css';
// Попапы Monaco: переменные для его собственных правил — сразу после темы.
import './styles/monaco.css';
import { startApplication } from './app';
import { styleMonacoPopovers } from './core/monaco-chrome';

// Материал попапов Monaco (блюр) — до старта: он появится вместе с редактором.
styleMonacoPopovers();

const mount = document.getElementById('app');
if (!mount) throw new Error('Не найден контейнер #app');

void startApplication(mount).catch((error: unknown) => {
  console.error('[chui] не удалось запустить приложение', error);
  const message = error instanceof Error ? error.message : String(error);
  mount.textContent = `Не удалось запустить приложение: ${message}`;
});
