/**
 * Браузерная автоматизация: правило и тексты.
 *
 * Запуск браузера, CDP и нажатия живут в main (`main/browser/browser.ts`) — там
 * процессы и сеть. Здесь только то, что можно проверить без браузера: разбор
 * адреса, скрипт-снимок страницы, его разбор в текст для модели и чтение строки
 * `DevTools listening on …`, по которой мы узнаём порт.
 *
 * Модуль намеренно чистый: `npm test` проверяет его без Chromium.
 */

/** Источник снимка: то, что вернул скрипт `SNAPSHOT_SCRIPT` со страницы. */
export interface SnapshotElement {
  /** Номер элемента в снимке — по нему агент кликает и печатает. */
  ref: string;
  /** Тег (`a`, `button`, `input`). */
  tag: string;
  /** Роль: link, button, textbox, checkbox… */
  role: string;
  /** Понятное имя: текст, `aria-label`, `placeholder`, значение. */
  name: string;
  /** Дополнительно: адрес ссылки, тип поля, состояние. */
  note?: string;
  /** Элемент недоступен для действия (disabled или скрыт). */
  disabled?: boolean;
}

export interface BrowserSnapshot {
  title: string;
  url: string;
  elements: SnapshotElement[];
  /** Видимый текст страницы, уже сжатый по длине. */
  text: string;
  /** Текст обрезан по потолку — модели об этом стоит знать. */
  truncated?: boolean;
}

/** Сколько элементов и символов текста отдаём модели: снимок — выжимка, а не дамп. */
export const MAX_SNAPSHOT_ELEMENTS = 120;
export const MAX_SNAPSHOT_TEXT = 8000;

/**
 * Имена исполняемых файлов Chromium, которые ищем в PATH, если путь не задан
 * настройкой. Firefox не подходит: он говорит не на CDP, а на своём протоколе.
 */
export const BROWSER_EXECUTABLES: readonly string[] = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'brave-browser',
  'microsoft-edge',
  'msedge',
  'google-chrome.exe',
  'chrome.exe',
  'msedge.exe',
];

/**
 * Разбор адреса, набранного человеком или моделью. Свой код запуска задаёт
 * человек, поэтому модель влияет только на адрес — но и его проверяем: `javascript:`
 * или `file:` в нашем браузере открывать незачем, а без схемы адрес по умолчанию
 * не откроется вовсе.
 */
export function normalizeBrowserUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  const text = raw.trim();
  if (!text) return { ok: false, reason: 'Не задан адрес' };
  // Пробел в адресе почти всегда означает забытую схему или склейку двух аргументов.
  if (/\s/.test(text)) return { ok: false, reason: `В адресе пробел: «${text}»` };

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text);
  // Схемой считаем двоеточие, за которым не порт: `localhost:3000` — это хост
  // с портом, а `javascript:alert(1)` — схема, и второй открывать незачем.
  const hasScheme = scheme !== null && !/^\d/.test(text.slice(scheme[0].length));
  if (hasScheme) {
    const name = scheme[1]!.toLowerCase();
    if (name !== 'http' && name !== 'https') {
      return { ok: false, reason: `Открываю только http и https, а тут «${name}:»` };
    }
  }
  const withScheme = hasScheme
    ? text
    : // Без схемы идём по https, а локальные адреса — по http: у них сертификата нет.
      `${isLocalHost(text) ? 'http' : 'https'}://${text}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, reason: `Не разобрать адрес: «${raw}»` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `Открываю только http и https, а тут ${url.protocol}` };
  }
  return { ok: true, url: url.toString() };
}

/**
 * Локальный ли адрес. У локального адреса нет сертификата, поэтому схема по
 * умолчанию — http. Набор хостов тот же, что у VS Code: и петлевые адреса, и
 * «все интерфейсы» (`0.0.0.0`, `[::]`) — это машина разработчика, а не чужой сайт.
 */
export function isLocalHost(text: string): boolean {
  const host = text.split(/[/?#]/, 1)[0] ?? '';
  return (
    host === 'localhost' ||
    host.startsWith('localhost:') ||
    host === '127.0.0.1' ||
    host.startsWith('127.0.0.1:') ||
    host === '[::1]' ||
    host.startsWith('[::1]:') ||
    host === '0.0.0.0' ||
    host.startsWith('0.0.0.0:') ||
    host === '[::]' ||
    host.startsWith('[::]:')
  );
}

/**
 * Адрес ведёт на локальную машину — такой открываем вкладкой в IDE, а не системным
 * браузером: это почти всегда свой запущенный сервер, и смотреть его надо рядом с
 * кодом. Ту же развилку делает терминал для ссылок (см. `app.ts`).
 */
export function isLocalUrl(target: string): boolean {
  try {
    const url = new URL(target);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return isLocalHost(url.host);
  } catch {
    return false;
  }
}

/**
 * Строка, которую Chromium пишет в stderr, когда поднимает отладочный порт:
 * `DevTools listening on ws://127.0.0.1:PORT/devtools/browser/<id>`. Другого
 * способа узнать порт при `--remote-debugging-port=0` нет — он выбирается на лету.
 */
export function parseDevToolsEndpoint(line: string): { wsUrl: string; httpUrl: string } | null {
  const match = /DevTools listening on (ws:\/\/\S+)/.exec(line);
  if (!match?.[1]) return null;
  try {
    const url = new URL(match[1]);
    return { wsUrl: match[1], httpUrl: `http://${url.host}` };
  } catch {
    return null;
  }
}

/**
 * Скрипт-снимок страницы. Выполняется на самой странице (`Runtime.evaluate`):
 * расставляет интерактивным элементам `data-chui-ref` и собирает их список вместе
 * с видимым текстом. Номера меток живут в DOM, поэтому клик и ввод работают со
 * снимком той же страницы, что видит человек.
 *
 * Скрипт самодостаточен и возвращает объект: `returnByValue` в CDP превращает его
 * в данные без нашего разбора JSON.
 */
export const SNAPSHOT_SCRIPT = `(() => {
  const el = (globalThis.document);
  if (!el) return { title: '', url: '', elements: [], text: '' };
  const clean = (value) => (value || '').replace(/\\s+/g, ' ').trim().slice(0, 160);
  const visible = (node) => {
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(node);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };
  const roleOf = (node) => {
    const explicit = node.getAttribute('role');
    if (explicit) return explicit;
    const tag = node.tagName;
    if (tag === 'A') return node.hasAttribute('href') ? 'link' : 'text';
    if (tag === 'BUTTON') return 'button';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'SUMMARY') return 'summary';
    if (tag === 'INPUT') {
      const type = (node.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      return 'textbox';
    }
    return 'element';
  };
  const nameOf = (node) => {
    const aria = node.getAttribute('aria-label');
    if (aria) return clean(aria);
    const labelled = node.getAttribute('aria-labelledby');
    if (labelled) {
      const target = el.getElementById(labelled);
      if (target) return clean(target.textContent);
    }
    if (node.id) {
      const label = el.querySelector('label[for="' + node.id + '"]');
      if (label) return clean(label.textContent);
    }
    const tag = node.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      const placed = node.closest('label');
      const hint = node.getAttribute('placeholder') || node.getAttribute('title') || node.getAttribute('name');
      return clean((placed && placed.textContent) || hint || node.value || '');
    }
    return clean(node.getAttribute('title') || node.textContent);
  };
  const noteOf = (node) => {
    const tag = node.tagName;
    if (tag === 'A') {
      const href = node.getAttribute('href') || '';
      return href ? (href.length > 120 ? href.slice(0, 120) + '…' : href) : '';
    }
    if (tag === 'INPUT') {
      const type = (node.getAttribute('type') || 'text').toLowerCase();
      return type === 'text' ? '' : type;
    }
    return '';
  };

  const selector = 'a[href], button, input, select, textarea, summary, [role], [onclick], [contenteditable="true"]';
  const nodes = Array.from(el.querySelectorAll(selector));
  const elements = [];
  let index = 0;
  for (const node of nodes) {
    if (index >= ${MAX_SNAPSHOT_ELEMENTS}) break;
    // Скрытое и выключенное показываем, только если у него есть имя: по нему
    // агент поймёт, что кнопка есть, но нажать её нельзя.
    const role = roleOf(node);
    const name = nameOf(node);
    if (!name && !visible(node)) continue;
    index += 1;
    const ref = String(index);
    node.setAttribute('data-chui-ref', ref);
    const entry = { ref, tag: node.tagName.toLowerCase(), role, name: name || '(без подписи)' };
    const note = noteOf(node);
    if (note) entry.note = note;
    if (!visible(node)) entry.disabled = true;
    else if (node.disabled === true) entry.disabled = true;
    elements.push(entry);
  }

  const text = clean(el.body ? el.body.innerText : '') || '';
  return {
    title: clean(el.title),
    url: String(el.location ? el.location.href : ''),
    elements,
    text: text.slice(0, ${MAX_SNAPSHOT_TEXT}),
    truncated: text.length > ${MAX_SNAPSHOT_TEXT},
  };
})()`;

/** Текст снимка для модели: заголовок, адрес, элементы с номерами и текст страницы. */
export function formatBrowserSnapshot(snapshot: BrowserSnapshot): string {
  const lines = [`Страница: ${snapshot.title || '(без заголовка)'}`, `Адрес: ${snapshot.url}`];

  if (snapshot.elements.length === 0) {
    lines.push('Интерактивных элементов не видно.');
  } else {
    lines.push(`Интерактивные элементы (${snapshot.elements.length}):`);
    for (const element of snapshot.elements) {
      const parts = [`${element.ref}. ${element.role} «${element.name}»`];
      if (element.note) parts.push(`→ ${element.note}`);
      if (element.disabled) parts.push('[недоступен]');
      lines.push(parts.join(' '));
    }
  }

  lines.push('Текст страницы:');
  lines.push(snapshot.text || '(текста нет)');
  if (snapshot.truncated) lines.push('… (текст страницы обрезан)');
  return lines.join('\n');
}

/**
 * Разбор того, что вернул скрипт: данные приходят из чужой страницы, поэтому
 * им нельзя верить на слово — ни в типах, ни в длине.
 */
export function sanitizeSnapshot(raw: unknown): BrowserSnapshot {
  const value = (raw ?? {}) as Record<string, unknown>;
  const elements: SnapshotElement[] = [];
  const list = Array.isArray(value.elements) ? value.elements : [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const ref = typeof entry.ref === 'string' ? entry.ref.trim() : '';
    if (!ref) continue;
    const element: SnapshotElement = {
      ref,
      tag: typeof entry.tag === 'string' ? entry.tag.slice(0, 24) : '?',
      role: typeof entry.role === 'string' ? entry.role.slice(0, 24) : 'element',
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.slice(0, 160) : '(без подписи)',
    };
    if (typeof entry.note === 'string' && entry.note) element.note = entry.note.slice(0, 160);
    if (entry.disabled === true) element.disabled = true;
    elements.push(element);
    if (elements.length >= MAX_SNAPSHOT_ELEMENTS) break;
  }

  const text = typeof value.text === 'string' ? value.text.slice(0, MAX_SNAPSHOT_TEXT + 1) : '';
  return {
    title: typeof value.title === 'string' ? value.title.slice(0, 200) : '',
    url: typeof value.url === 'string' ? value.url.slice(0, 500) : '',
    elements,
    text: text.slice(0, MAX_SNAPSHOT_TEXT),
    ...(value.truncated === true || text.length > MAX_SNAPSHOT_TEXT ? { truncated: true } : {}),
  };
}
