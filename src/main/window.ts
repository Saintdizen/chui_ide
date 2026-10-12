import { BrowserWindow, nativeTheme, shell } from 'electron';
import path from 'node:path';
import { PushTopic, type WindowBounds, type WindowState } from '../shared/api';
import { windowBackground } from '../shared/colors';
import { pushToRenderers } from './ipc/push';
import { APP_ORIGIN } from './protocol';
import { isSafeExternalUrl, isSameUrlOrigin } from '../shared/url';

/**
 * Адрес dev-сервера прокидывает scripts/dev.mjs. Если переменной нет —
 * грузим собранный renderer из dist.
 */
const DEV_SERVER_URL = process.env.CHUI_DEV_SERVER_URL;

interface WindowOptions {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  /** Какую страницу renderer грузить: у стартового окна своя точка входа. */
  page: 'index.html' | 'welcome.html';
  /** Разворачивать на весь экран при создании (у IDE — да, у старта — нет). */
  maximizable?: boolean;
}

let ideWindow: BrowserWindow | null = null;

/**
 * Окно IDE. Оно одно на приложение: повторный вызов поднимает уже открытое,
 * а не создаёт второе.
 */
export function openIdeWindow(): BrowserWindow {
  if (ideWindow && !ideWindow.isDestroyed()) {
    if (ideWindow.isMinimized()) ideWindow.restore();
    ideWindow.focus();
    return ideWindow;
  }

  const window = createAppWindow({
    width: 1320,
    height: 860,
    minWidth: 820,
    minHeight: 560,
    page: 'index.html',
  });
  ideWindow = window;
  window.on('closed', () => {
    if (ideWindow === window) ideWindow = null;
  });
  return window;
}

/**
 * Стартовое окно: открыть или склонировать проект. Своя рамка та же, что
 * у IDE, — окно меньше, но выглядит частью приложения, а не системным диалогом.
 */
export function createWelcomeWindow(): BrowserWindow {
  return createAppWindow({
    width: 840,
    height: 560,
    minWidth: 640,
    minHeight: 460,
    page: 'welcome.html',
  });
}

function createAppWindow(options: WindowOptions): BrowserWindow {
  const isMac = process.platform === 'darwin';

  const window = new BrowserWindow({
    width: options.width,
    height: options.height,
    minWidth: options.minWidth,
    minHeight: options.minHeight,
    show: false,
    backgroundColor: windowBackground(nativeTheme.shouldUseDarkColors ? 'dark' : 'light'),
    title: 'chui_iDE',
    // Своя рамка. На macOS оставляем системные «светофоры» — без них окно
    // теряет привычные кнопки, — а на Linux и Windows рамку рисует renderer.
    ...(isMac
      ? // Светофоры центрируются в шапке: `--topbar_height` = 36 px, кнопка 12 px → отступ 12 px.
        { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 12, y: 12 } }
      : { frame: false }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Песочница включена: renderer живёт в OS-песочнице Chromium, а preload
      // собирается одним файлом без require на локальные модули
      // (scripts/bundle-preload.mjs) — иначе sandbox его не запустит. Изоляция
      // контекста тоже включена, у renderer нет доступа к Node — в него попадает
      // только узкий мост window.chui.
      sandbox: true,
      spellcheck: false,
    },
  });

  window.once('ready-to-show', () => window.show());

  // Кнопки своей рамки зависят от состояния окна, а изменить его может и оконный менеджер.
  const notifyState = (): void => pushToRenderers(PushTopic.WindowStateChanged, windowState(window));
  window.on('maximize', notifyState);
  window.on('unmaximize', notifyState);
  window.on('enter-full-screen', notifyState);
  window.on('leave-full-screen', notifyState);

  const base = (DEV_SERVER_URL ?? APP_ORIGIN).replace(/\/$/, '');

  // Свой адрес (dev-сервер или собранный renderer `app://`) от чужого отличает
  // `isSameUrlOrigin`: перезагрузку своей страницы пускаем, уход на сайт — наружу.
  const isAppUrl = (target: string): boolean => isSameUrlOrigin(target, base);

  // Ссылки из интерфейса отдаём системе, но только знакомые схемы: `file:` или
  // своя схема в чужом обработчике — не то, чего человек ждёт от «открой ссылку».
  // Ссылки из интерфейса отдаём системе, но только знакомые схемы: `file:` или
  // своя схема в чужом обработчике — не то, чего человек ждёт от «открой ссылку».
  const openExternal = (url: string): void => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
  };

  window.webContents.setWindowOpenHandler(({ url }) => {
    // Свою страницу наружу не отдаём: `window.open` на свой же адрес — это не «открой
    // ссылку», а попытка второго окна, и системный браузер тут ни при чём.
    if (!isAppUrl(url)) openExternal(url);
    // Новое окно не создаём: у IDE своя рамка, и второе окно без неё выглядит чужим.
    return { action: 'deny' };
  });

  // Навигацию самой страницы запрещаем: IDE — не браузер, и уход вкладки на сайт
  // оставил бы человека без редактора. Внешний адрес открываем в системном браузере.
  // Но перезагрузку СВОЕЙ страницы пускаем: в разработке Vite шлёт full-reload, и без
  // этой оговорки каждое обновление кода открывало бы системный браузер, а окно
  // оставалось бы со старым кодом (навигацию мы бы отменили, уведя её наружу).
  window.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    openExternal(url);
  });

  void window.loadURL(`${base}/${options.page}`);
  if (DEV_SERVER_URL) window.webContents.openDevTools({ mode: 'detach' });

  return window;
}

export function windowState(window: BrowserWindow): WindowState {
  return {
    maximized: window.isMaximized(),
    fullScreen: window.isFullScreen(),
    platform: process.platform,
    customControls: process.platform !== 'darwin',
  };
}

/**
 * Применяет новые размеры, зажимая их по минимуму окна.
 *
 * Вынесено отдельной функцией, потому что растягивание безрамочного окна
 * на Linux делает renderer (системных краёв у такого окна нет), и эту
 * арифметику нужно проверять тестом — см. `npm run smoke:window`.
 */
export function applyBounds(window: BrowserWindow, patch: Partial<WindowBounds>): WindowBounds {
  const current = window.getBounds();
  const [minWidth, minHeight] = window.getMinimumSize();

  window.setBounds({
    x: Math.round(patch.x ?? current.x),
    y: Math.round(patch.y ?? current.y),
    width: Math.round(Math.max(patch.width ?? current.width, minWidth)),
    height: Math.round(Math.max(patch.height ?? current.height, minHeight)),
  });

  return window.getBounds();
}
