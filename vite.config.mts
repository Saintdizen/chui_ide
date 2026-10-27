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
    // Предупреждение о крупных чанках глушим: `index` несёт свой редактор и
    // терминал, он заведомо больше любого разумного порога.
    //
    // Решение «не делить» измерено, а не заявлено (п. 38, повтор —
    // `NODE_OPTIONS=--experimental-vm-modules npx tsx scripts/chunk-cost.ts`):
    // чанк 941 КБ / 294 КБ в gzip, разбор и компиляция в V8 — 34–37 мс на
    // весь кусок (0,036 мс на КБ). Самая большая из модалок, `settings-modal`
    // (107 КБ, 8 %), стоит 3,9 мс; все модалки вместе (216 КБ) — 7,8 мс;
    // `app.ts` (163 КБ) ленивым не станет всё равно. Значит ленивая загрузка
    // вернула бы 4–8 мс старта и добавила бы ожидание при первом открытии
    // настроек. Если старт когда-нибудь станет медленным — смотреть
    // `project:paint` в perf-замерах, а не размер чанка: разбор здесь не узкое
    // место. Бесконечность — самый честный способ сказать «это не проблема».
    chunkSizeWarningLimit: Number.POSITIVE_INFINITY,
    // В rolldown-vite `build.rollupOptions` — лишь устаревший алиас к `rolldownOptions`,
    // и он подставляется только если `rolldownOptions` не задан (`??=`). Поэтому обе
    // настройки должны жить в одном блоке: два разных поля — и `input` молча терялся,
    // собирался один `index.html`, а стартовое окно получало 404 на `welcome.html`.
    rolldownOptions: {
      // Две точки входа: окно IDE и стартовое окно выбора проекта.
      // Стартовое не тянет редактор и терминал, поэтому грузится мгновенно.
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
    // Порт можно переопределить: второй dev-экземпляр (другой профиль) — обычное дело,
    // а `strictPort` иначе не даёт им жить рядом.
    port: Number(process.env.CHUI_DEV_PORT) || 5273,
    strictPort: true,
  },
});
