import { defineConfig, type Plugin } from 'vite';

// Политика безопасности в проде не должна разрешать соединения с localhost:
// они нужны только HMR-сокету dev-сервера. Тег <meta> в HTML один на оба
// режима, поэтому лишние разрешения снимаем на сборке, а не держим в исходнике.
const dropDevCsp: Plugin = {
  name: 'chui-drop-dev-csp',
  apply: 'build',
  transformIndexHtml: (html) => html.replace(/\s*ws:\/\/localhost:\* http:\/\/localhost:\*/g, ''),
};

/**
 * Собираем только renderer. Main и preload компилирует tsc (tsconfig.main.json),
 * поэтому здесь нет никаких плагинов Electron — процессы полностью развязаны.
 */
export default defineConfig({
  plugins: [dropDevCsp],
  root: 'src/renderer',
  base: './',
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    // Electron 30+ несёт Chromium, транспилировать в ES5 незачем.
    target: 'chrome124',
    sourcemap: true,
    // Предупреждение о крупных чанках глушим: `index` несёт Monaco и xterm,
    // он заведомо больше любого разумного порога, но это осознанно — делить
    // его незачем, а шум в каждой сборке только мешает. Бесконечность —
    // самый честный способ сказать «это не проблема».
    chunkSizeWarningLimit: Number.POSITIVE_INFINITY,
    // В rolldown-vite `build.rollupOptions` — лишь устаревший алиас к `rolldownOptions`,
    // и он подставляется только если `rolldownOptions` не задан (`??=`). Поэтому обе
    // настройки должны жить в одном блоке: два разных поля — и `input` молча терялся,
    // собирался один `index.html`, а стартовое окно получало 404 на `welcome.html`.
    rolldownOptions: {
      // Две точки входа: окно IDE и стартовое окно выбора проекта.
      // Стартовое не тянет Monaco и xterm, поэтому грузится мгновенно.
      input: {
        index: 'index.html',
        welcome: 'welcome.html',
      },
      // Отчёт о таймингах плагинов (rolldown печатает его после каждой сборки)
      // выключаем: это диагностика сборщика, к коду проекта отношения не имеет.
      checks: { bundlerTimings: false },
    },
  },
  server: {
    port: 5273,
    strictPort: true,
  },
  // Monaco подтягивает языковые модули динамическими импортами. Фиксируем пакет
  // в предсборке: иначе Vite пересобирает его на лету и хеши разъезжаются,
  // а модуль подсветки грузится отдельным куском.
  optimizeDeps: {
    include: ['monaco-editor'],
  },
  worker: {
    format: 'es',
  },
});
