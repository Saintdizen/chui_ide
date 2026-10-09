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
    rollupOptions: {
      // Две точки входа: окно IDE и стартовое окно выбора проекта.
      // Стартовое не тянет Monaco и xterm, поэтому грузится мгновенно.
      input: {
        index: 'index.html',
        welcome: 'welcome.html',
      },
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
