import {
  type ChatAttachment,
  type DirEntry,
  MAX_CHAT_IMAGES,
  MAX_IMAGE_BYTES,
  type PickedImage,
} from '../../shared/api';
import { entryIsDirectory } from '../../shared/entry-kind';
import { estimateAttachmentTokens, estimateContextPrice } from '../../shared/context-fit';
import { dropAttachment, keepLatest, takeSent } from '../../shared/chat-attachments';
import type { DocumentStore } from '../core/document-store';
import type { EditorApi } from '../core/editor-api';
import type { GitModel } from '../core/git-model';
import { languageFromPath } from '../core/languages';
import type { RpcClient } from '../core/rpc';
import { relativePath, type WorkspaceModel } from '../core/workspace-model';
import type { ChatSession } from './chat-session';
import { formatBytes } from './chat-text';
import { basename, clear, h, svgIcon } from './dom';
import { showToast } from './toast';

/**
 * Контекст, который пользователь прикладывает к вопросу: выделение, файл,
 * пометки языка, изображения и `@`-упоминания файлов проекта.
 *
 * Вынесено из `chat.ts`: панель ведёт разговор, а сбор вложений и полоса чипов —
 * отдельная забота. Модуль знает только активную беседу (через хозяина) и
 * перерисовывает свою полосу; работа с редактором и проектом приходит колбэками.
 */

/** Больше в промпт не влезет: файл целиком нужен редко, а место занимает всегда. */
const MAX_ATTACHMENT_CHARS = 40_000;

/** Значок чипа по виду вложения: ошибки — предупреждение, беседа — реплика. */
const CHIP_ICON: Partial<Record<ChatAttachment['kind'], 'warning' | 'chat'>> = {
  problems: 'warning',
  session: 'chat',
};

/** Сколько файлов разбираем целиком: остальные — только списком. */
const MAX_DIFF_FILES = 10;

/** Каталоги, которые в `@`-подсказку не попадают: шум и вес обхода. */
const MENTION_SKIP = new Set(['node_modules', '.git', 'dist', 'out', '.cache', '__pycache__', '.venv', 'release']);
const MAX_MENTIONS = 4000;

/** Служебные константы оценки: шапка блока и строка адреса в промпте. */
const WEB_LINE_CHARS = 120;
const PROBLEM_LINE_CHARS = 32;

/** Место проекта по смыслу: строка кода и где она лежит. Для `#codebase`. */
export interface CodebasePlace {
  path: string;
  /** Номер строки с 1: так же, как в редакторе и в отчётах поиска. */
  line: number;
  text: string;
}

export interface AttachmentsDeps {
  rpc: RpcClient;
  documents: DocumentStore;
  editors: EditorApi;
  workspace: WorkspaceModel;
  /** Изменения репозитория: нужны только для `#diff`. */
  git?: GitModel;
  /**
   * Места по смыслу — для `#codebase`: запрос словами → готовые места проекта.
   * Тот же поиск, что у палитры по смыслу; без него пункт молчит и говорит, почему.
   */
  codebase?: (query: string) => Promise<readonly CodebasePlace[]>;
  /** Что сейчас набрано в поле ввода: это и есть запрос для `#codebase`. */
  composerText(): string;
  /**
   * Адрес открытой страницы встроенного браузера — для `#web`. Нет вкладки или
   * адрес пуст — пункт говорит, что прикладывать нечего.
   */
  browserUrl?(): string;
  /** Активная беседа: у каждой вкладки свои вложения. */
  session(): ChatSession;
  /** Сколько токенов стоит вид `#` прямо сейчас, до прикладывания. */
  contextCost?(kind: ContextNoArg): number | null;
  /** Вернуть фокус в поле ввода после прикладывания контекста. */
  focus(): void;
}

/** Виды контекста, у которых есть пункт `#` (без изображений и буфера). */
export type ContextNoArg = 'selection' | 'file' | 'problems' | 'diff' | 'codebase' | 'web';

export interface AttachmentsView {
  /** Полоса чипов: приложенный к вопросу контекст. */
  element: HTMLElement;
  /** Перерисовать чипы активной беседы. */
  render(): void;
  /** Снять вложения перед отправкой: контекст принадлежит конкретному вопросу. */
  takeForSend(): ChatAttachment[];
  /** Приложить то, что открыто в редакторе: выделение, а если его нет — файл. */
  attachBest(): void;
  /** Приложить контекст вида `#`: выделение, файл, пометки языка, правки или места проекта. */
  attachFrom(kind: ContextNoArg): void;
  /**
   * Цена вида `#` в токенах — до прикладывания. `null` — посчитать нечем (нет
   * файла, выделения, вкладки); `diff`/`codebase` строит main, и цену им не назвать.
   */
  contextPrice(kind: ContextNoArg): number | null;
  /** Сколько токенов уже приложено к вопросу (текст чипов, картинки — по счётчику). */
  attachedTokens(): number;
  /** Выбор изображений системным диалогом. */
  attachImagesFromDialog(): Promise<void>;
  /** Приложить готовое изображение (data-URL): снимок страницы из встроенного браузера. */
  attachImage(image: PickedImage): void;
  /** Приложить готовый контекст: журнал консоли страницы и подобное. */
  attachContext(item: ChatAttachment): void;
  /** Файлы из буфера и перетаскивания. */
  attachFiles(files: readonly File[]): Promise<void>;
  /** Показать файл или папку по пути (перетаскивание из дерева). */
  attachPath(target: string): Promise<void>;
  /** Приложить файл проекта по пути из `@`-подсказки. */
  attachMention(path: string): void;
  /** Список путей для `@`-подсказки; `null` — ещё не собран. */
  mentionPaths(): string[] | null;
  /** Пересобрать список путей (при смене папки). */
  requestMentions(): void;
}

export function createAttachments(deps: AttachmentsDeps): AttachmentsView {
  /** Полоса чипов над полем ввода: у каждой беседы своя, поэтому перерисовываем целиком. */
  const element = h('div', { class: 'composer-chips', hidden: true });

  /**
   * Подписи чипов с прошлой отрисовки и беседа, к которой они относились. Полосу
   * пересобираем целиком, но анимировать нужно ТОЛЬКО что добавленный чип: иначе
   * при каждом добавлении/снятии оживали бы и все остальные — полоса мигала бы.
   */
  let shownLabels = new Set<string>();
  let shownSession: ChatSession | null = null;
  /** Узлы чипов по порядку — чтобы уметь схлопнуть снимаемый (см. `removeAttachment`). */
  let chipNodes: HTMLElement[] = [];

  function render(): void {
    const session = deps.session();
    const attachments = session.attachments;
    // Сменили вкладку — это не «добавление», показывать анимацию появления нечем.
    const sameSession = shownSession === session;
    clear(element);
    element.hidden = attachments.length === 0;
    chipNodes = [];
    const nextLabels = new Set<string>();

    attachments.forEach((item, index) => {
      const image = item.kind === 'image' && item.dataUrl ? item : null;
      const isNew = sameSession && !shownLabels.has(item.label);
      nextLabels.add(item.label);
      const chip = h(
        'span',
        {
          class: `chip chip-static${image ? ' chip-image' : ''}${isNew ? ' is-new' : ''}`,
          // У справки из беседы в подсказке видна ссылка на источник: по ней понятно,
          // из какого разговора приложен текст и что он ушёл отдельным блоком.
          title: image
            ? `${item.title} · ${formatBytes(item.bytes ?? 0)}`
            : `${item.title}${item.uri ? ` · ${item.uri}` : ''}\n\n${item.text.slice(0, 300)}`,
        },
        // У картинки вместо значка — она сама: по миниатюре видно, что приложено,
        // и не приходится открывать файл, чтобы это проверить.
        image
          ? h('img', { class: 'chip-thumb', src: image.dataUrl!, alt: item.label })
          : svgIcon(CHIP_ICON[item.kind] ?? 'file', 12),
        h('span', { class: 'chip-name' }, item.label),
        image ? h('span', { class: 'chip-hint' }, formatBytes(item.bytes ?? 0)) : null,
        h(
          'button',
          {
            class: `chip-keep${isKept(item.label) ? ' is-active' : ''}`,
            type: 'button',
            // Право решать — за человеком, и видно это прямо в чипе: иначе
            // непонятно, почему файл вернулся после сжатия беседы.
            title: isKept(item.label)
              ? 'Останется после сжатия беседы — нажмите, чтобы не переносить'
              : 'Оставить после сжатия беседы',
            onClick: () => toggleKept(item),
          },
          svgIcon('pin', 10),
        ),
        h(
          'button',
          {
            class: 'chip-remove',
            type: 'button',
            title: 'Убрать из контекста',
            onClick: () => removeAttachment(index),
          },
          svgIcon('close', 10),
        ),
      );
      chipNodes.push(chip);
      element.appendChild(chip);
    });

    shownLabels = nextLabels;
    shownSession = session;
  }

  function addAttachment(item: ChatAttachment | null): void {
    if (!item) return;
    const session = deps.session();
    if (session.attachments.some((existing) => existing.label === item.label)) {
      showToast('Этот контекст уже приложен');
      return;
    }
    session.attachments = [...session.attachments, item];
    render();
  }

  function removeAttachment(index: number): void {
    const session = deps.session();
    const removed = session.attachments[index];
    const commit = (): void => {
      session.attachments = session.attachments.filter((_, position) => position !== index);
      // Человек снял контекст до отправки — он не должен пережить сжатие беседы.
      if (removed) dropAttachment(session, removed.label);
      render();
    };
    // Схлопываем чип перед перерисовкой: полоса пересобирается целиком, и без
    // этого снятый чип пропадал бы мгновенно, без связи с нажатием.
    const chip = chipNodes[index];
    if (!chip) {
      commit();
      return;
    }
    chip.classList.add('is-leaving');
    chip.addEventListener('animationend', commit, { once: true });
  }

  /** Стоит ли пометка «оставить после сжатия» на этом чипе. */
  function isKept(label: string): boolean {
    return (deps.session().kept ?? []).some((item) => item.label === label);
  }

  /**
   * Переключить пометку «оставить после сжатия беседы».
   *
   * Без неё файл живёт до первого пересказа: резюме не повторяет присланный код,
   * и тащить его дальше без спроса незачем. С ней файл уезжает и после сжатия, то
   * есть решает человек, а не догадка по свежести.
   */
  function toggleKept(item: ChatAttachment): void {
    const session = deps.session();
    if (isKept(item.label)) dropAttachment(session, item.label);
    else session.kept = keepLatest([...(session.kept ?? []), item]);
    render();
  }

  /** Файл из буфера или перетаскивания — в data-URL средствами браузера. */
  function readAsDataUrl(file: File): Promise<string | null> {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }

  function addImage(image: PickedImage): void {
    const session = deps.session();
    if (session.attachments.length >= MAX_CHAT_IMAGES) {
      showToast(`К вопросу можно приложить не больше ${MAX_CHAT_IMAGES} изображений`, 'error');
      return;
    }

    // Подпись у картинки — имя файла, а имя у двух разных вставок может совпасть:
    // считаем повтором только те же имя, размер и данные.
    const duplicate = session.attachments.some(
      (item) => item.kind === 'image' && item.label === image.name && item.bytes === image.bytes,
    );
    if (duplicate) {
      showToast('Это изображение уже приложено');
      return;
    }

    session.attachments = [
      ...session.attachments,
      {
        kind: 'image',
        label: image.name,
        title: `Изображение ${image.name}`,
        text: '',
        dataUrl: image.dataUrl,
        bytes: image.bytes,
      },
    ];
    render();
  }

  /** Файлы из буфера и из перетаскивания идут одним путём: и там, и там это File. */
  async function attachFiles(files: readonly File[]): Promise<void> {
    const images = files.filter((file) => file.type.startsWith('image/'));
    if (images.length === 0) {
      showToast('Можно приложить только изображения', 'error');
      return;
    }

    for (const file of images.slice(0, MAX_CHAT_IMAGES)) {
      if (file.size > MAX_IMAGE_BYTES) {
        showToast(
          `${file.name || 'изображение'}: ${formatBytes(file.size)} — больше предела ${formatBytes(MAX_IMAGE_BYTES)}`,
          'error',
        );
        continue;
      }
      const dataUrl = await readAsDataUrl(file);
      if (dataUrl) addImage({ name: file.name || 'вставка из буфера', mime: file.type, bytes: file.size, dataUrl });
    }
    deps.focus();
  }

  /** Кнопка меню: выбор файла системным диалогом (читает файлы main). */
  async function attachImagesFromDialog(): Promise<void> {
    try {
      const picked = await deps.rpc.request('dialog.pickImages');
      for (const image of picked) addImage(image);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
    deps.focus();
  }

  /** Собрать вложение из того, что сейчас открыто в редакторе. */
  function attachmentFrom(kind: 'selection' | 'file' | 'problems'): ChatAttachment | null {
    const path = deps.editors.currentPath;

    if (kind === 'problems') {
      const items = deps.editors.markers(path ?? undefined);
      if (items.length === 0) {
        showToast('Ошибок и предупреждений нет');
        return null;
      }
      return {
        kind,
        label: `ошибки: ${items.length}`,
        title: path ? `Пометки языка в ${path}` : 'Пометки языка',
        text: items
          .map((item) => `${basename(item.path)}:${item.line}:${item.column} [${item.severity}] ${item.message}`)
          .join('\n'),
      };
    }

    const document = path ? deps.documents.get(path) : undefined;
    if (!path || !document) {
      showToast('Нет открытого файла', 'error');
      return null;
    }

    if (kind === 'selection') {
      const selection = deps.editors.selectedText();
      if (!selection.trim()) {
        showToast('Сначала выделите фрагмент в редакторе', 'error');
        return null;
      }
      return {
        kind,
        label: `выделение · ${basename(path)}`,
        title: `Выделение из ${path}`,
        text: `\`\`\`${document.languageId}\n${selection}\n\`\`\``,
      };
    }

    const text =
      document.value.length > MAX_ATTACHMENT_CHARS
        ? `${document.value.slice(0, MAX_ATTACHMENT_CHARS)}\n… (файл обрезан)`
        : document.value;
    return {
      kind: 'file',
      label: basename(path),
      title: `Файл ${path}`,
      text: `\`\`\`${document.languageId}\n${text}\n\`\`\``,
    };
  }

  /**
   * Правки рабочего дерева и индекса для `#diff`.
   *
   * Без этого модель видит файл в исходном виде и предлагает сделать то, что уже
   * сделано. Берём и индекс, и рабочее дерево: для вопроса «что я уже поменял»
   * разница между ними не важна, а пропустить одну половину — значит соврать.
   *
   * Не git-репозиторий — не ошибка: чат живёт и в обычной папке, поэтому молча
   * возвращаем `null` без тоста об ошибке.
   */
  async function attachmentFromDiff(): Promise<ChatAttachment | null> {
    const git = deps.git;
    if (!git?.isRepository) {
      showToast('Это не git-репозиторий', 'error');
      return null;
    }
    const files = [...git.staged, ...git.unstaged];
    if (files.length === 0) {
      showToast('Изменений нет: рабочее дерево чистое');
      return null;
    }
    // Больше десятка файлов в один вопрос — это уже не контекст, а дамп. Список
    // остальных всё равно уходит: по нему видно, что ещё тронуто.
    const parts: string[] = [];
    const limit = Math.min(files.length, MAX_DIFF_FILES);
    for (const file of files.slice(0, limit)) {
      const patch = await diffTextOf(git, file.path, file.staged);
      parts.push(`### ${file.path}\n${patch}`);
    }
    if (files.length > limit) {
      const rest = files.slice(limit).map((file) => file.path);
      parts.push(`### Ещё изменено (без содержимого):\n${rest.join('\n')}`);
    }
    return {
      kind: 'diff',
      label: `правки: ${files.length}`,
      title: `Незакоммиченные изменения (${files.length})`,
      text: parts.join('\n\n'),
    };
  }

  /**
   * Текст одного файла в виде `@@`-блоков: для `#diff` достаточно формы `git diff`
   * без шапки: заголовок файла уже есть в `### path`.
   */
  async function diffTextOf(git: GitModel, path: string, staged: boolean): Promise<string> {
    try {
      const diff = await git.diff(path, staged);
      if (diff.hunks.length === 0) return '(без построчных изменений)';
      // У блока есть только границы — ни текста, ни знаков: тянем строки из двух версий
      // файла. Контекст у блока берётся в его рамках: `oldCount` в старом файле.
      const before = diff.original.split('\n');
      const after = diff.modified.split('\n');
      const lines: string[] = [];
      for (const hunk of diff.hunks) {
        lines.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
        const oldFrom = Math.max(0, hunk.oldStart - 1);
        const newFrom = Math.max(0, hunk.newStart - 1);
        for (const line of before.slice(oldFrom, oldFrom + hunk.oldCount)) lines.push(`-${line}`);
        for (const line of after.slice(newFrom, newFrom + hunk.newCount)) lines.push(`+${line}`);
      }
      return lines.join('\n');
    } catch (error) {
      // Один файл не прочитался — не повод терять остальные: пишем причину на его месте.
      return `(не удалось получить diff: ${error instanceof Error ? error.message : String(error)})`;
    }
  }

  /** Выделение, а если его нет — файл целиком. */
  function attachBest(): void {
    if (deps.editors.selectedText().trim()) addAttachment(attachmentFrom('selection'));
    else addAttachment(attachmentFrom('file'));
  }

  /**
   * Контекст `#codebase`: места проекта по смыслу вопроса. Берём тот же поиск, что
   * в палитре по смыслу, но прикладываем не список на экране, а отрывки строк:
   * модели нужно то, что написано, а не название места.
   *
   * Вопрос — текст, набранный в поле ввода: его и обшариваем. Пусто — берём файл
   * и подсказываем, что можно написать словами.
   */
  async function attachmentFromCodebase(): Promise<ChatAttachment | null> {
    if (!deps.codebase) {
      showToast('Места по смыслу недоступны', 'error');
      return null;
    }
    const query = deps.composerText().trim();
    if (!query) {
      showToast('Напишите в поле ввода, что искать', 'info');
      return null;
    }
    let places: readonly CodebasePlace[];
    try {
      places = await deps.codebase(query);
    } catch (error) {
      showToast(`Поиск не удался: ${error instanceof Error ? error.message : String(error)}`, 'error');
      return null;
    }
    if (places.length === 0) {
      showToast(`Ничего не нашлось по «${query}»`, 'info');
      return null;
    }

    const lines: string[] = [];
    let size = 0;
    let used = 0;
    for (const place of places) {
      const line = `${place.path}:${place.line}: ${place.text.replaceAll('\n', ' ')}`;
      // Предел тот же, что у файла целиком: место в промпте не бесконечное.
      if (size + line.length > MAX_ATTACHMENT_CHARS) break;
      lines.push(line);
      size += line.length + 1;
      used += 1;
    }
    const rest = places.length - used;

    return {
      kind: 'codebase',
      label: 'Места в проекте',
      title: `Места в проекте по «${query}»`,
      text: `${lines.join('\n')}${rest > 0 ? `\n… ещё мест: ${rest}` : ''}`,
    };
  }

  /** Собрать вложение по произвольному пути: файл целиком или список папки. */
  async function attachmentFromPath(target: string, kind: 'file' | 'dir'): Promise<ChatAttachment | null> {
    try {
      if (kind === 'dir') {
        const entries = await deps.workspace.readDir(target);
        const list = entries.map((entry) => `${entry.name}${entryIsDirectory(entry) ? '/' : ''}`).join('\n');
        return {
          kind: 'note',
          label: `${basename(target)}/`,
          title: `Папка ${target}`,
          text: `Содержимое папки ${target}:\n\n${list}`,
        };
      }
      const file = await deps.rpc.request('workspace.readFile', { path: target });
      const text =
        file.text.length > MAX_ATTACHMENT_CHARS
          ? `${file.text.slice(0, MAX_ATTACHMENT_CHARS)}\n… (файл обрезан)`
          : file.text;
      return {
        kind: 'file',
        label: basename(target),
        title: `Файл ${target}`,
        text: `\`\`\`${languageFromPath(target)}\n${text}\n\`\`\``,
      };
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
      return null;
    }
  }

  /** Вложение из пути: тип определяем через stat, чтобы папка и файл шли разными путями. */
  async function attachPath(target: string): Promise<void> {
    try {
      const stat = await deps.rpc.request('workspace.stat', { path: target });
      addAttachment(await attachmentFromPath(target, stat.kind === 'directory' ? 'dir' : 'file'));
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  /** Приложить файл проекта по пути из `@`-подсказки: путь относительный — склеиваем с корнем. */
  function attachMention(path: string): void {
    const root = deps.workspace.root ?? '';
    void attachPath(root ? `${root}/${path.replace(/\/$/, '')}` : path);
  }

  /* ── @-упоминания: список путей проекта ─────────────────────────────────── */

  /** Плоский список путей для подсказки `@`: пересобирается при смене папки. */
  let mentionCache: string[] | null = null;
  /** Номер текущего обхода: старый, доехавший позже нового, не должен затирать кэш. */
  let mentionRun = 0;

  async function collectMentions(): Promise<void> {
    const root = deps.workspace.root;
    const run = (mentionRun += 1);
    if (!root) {
      mentionCache = [];
      return;
    }

    const result: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      // Корень сменился, пока гуляли: обход устарел, его результат уже не нужен.
      if (run !== mentionRun) return;
      if (depth > 6 || result.length >= MAX_MENTIONS) return;
      let entries: DirEntry[];
      try {
        entries = await deps.workspace.readDir(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (run !== mentionRun) return;
        if (result.length >= MAX_MENTIONS) return;
        const rel = relativePath(root, entry.path);
        if (entryIsDirectory(entry)) {
          if (MENTION_SKIP.has(entry.name)) continue;
          result.push(`${rel}/`);
          await walk(entry.path, depth + 1);
        } else {
          result.push(rel);
        }
      }
    };
    await walk(root, 0);
    // Кэш пишет только последний обход: иначе устаревший перетёр бы свежий.
    if (run === mentionRun) mentionCache = result;
  }

  /**
   * Вложения приложены к конкретному вопросу: при отправке их снимаем и отдаём.
   *
   * Копию оставляем в `session.kept`: после сжатия беседы модель получает одно
   * резюме, и без этой копии она продолжала бы работу, не видя кода, о котором
   * речь (см. `keptContextMessage`).
   */
  function takeForSend(): ChatAttachment[] {
    const session = deps.session();
    // Копию для сжатия делает пометка на чипе, а не сама отправка: человек сам
    // решает, что переживёт пересказ (см. `toggleKept`).
    const sent = takeSent(session);
    render();
    return sent;
  }

  /** Сколько токенов уже приложено к вопросу: все чипы разом. */
  function attachedTokens(): number {
    return deps.session().attachments.reduce((sum, item) => sum + estimateAttachmentTokens(item), 0);
  }

  /** Приложить контекст вида `#`. */
  function attachFrom(kind: ContextNoArg): void {
    // Страница браузера — только адрес: вкладку открывает человек, а не мы.
    if (kind === 'web') {
      const url = deps.browserUrl?.() ?? '';
      if (!url) {
        showToast('В браузере не открыта страница');
        return;
      }
      addAttachment({
        kind: 'web',
        label: basename(url),
        title: `Страница ${url}`,
        text: `Человек смотрит страницу: ${url}\nЕё содержимое можно прочитать инструментом \`web\`.`,
      });
      return;
    }
    // Остальное асинхронно: `git status` знает только модель, а чтение файлов и
    // поиск по смыслу идут через RPC.
    if (kind === 'diff' || kind === 'codebase') {
      void (kind === 'diff' ? attachmentFromDiff() : attachmentFromCodebase()).then((item) => {
        if (item) addAttachment(item);
      });
      return;
    }
    addAttachment(attachmentFrom(kind));
  }

  /**
   * Цена вида `#` в токенах — до того, как его приложили. Считаем по длине
   * источника, а не по готовому тексту: тянуть содержимое файла ради цифры в меню
   * дороже, чем ошибиться в ней (тот же принцип — `estimateContextPrice`).
   * `null` — посчитать нечего: пункт покажется без цифры, а не соврёт нулём.
   */
  function contextPrice(kind: ContextNoArg): number | null {
    if (kind === 'web') {
      const url = deps.browserUrl?.() ?? '';
      return url ? estimateContextPrice({ chars: url.length + WEB_LINE_CHARS }) : null;
    }
    const path = deps.editors.currentPath;
    if (kind === 'problems') {
      const items = deps.editors.markers(path ?? undefined);
      return estimateContextPrice({ chars: items.length * PROBLEM_LINE_CHARS });
    }
    if (kind === 'selection') {
      const text = deps.editors.selectedText();
      if (text.trim().length === 0) return null;
      return estimateContextPrice({ chars: Math.min(text.length, MAX_ATTACHMENT_CHARS) });
    }
    if (kind === 'file') {
      const doc = path ? deps.documents.get(path) : undefined;
      if (!doc) return null;
      return estimateContextPrice({ chars: Math.min(doc.value.length, MAX_ATTACHMENT_CHARS) });
    }
    // `#diff` и `#codebase` строятся запросом к модели — на глаз цену не назвать.
    return null;
  }

  return {
    element,
    render,
    takeForSend,
    attachBest,
    attachFrom,
    contextPrice,
    attachedTokens,
    attachImagesFromDialog,
    attachImage: (image) => addImage(image),
    attachContext: (item) => addAttachment(item),
    attachFiles,
    attachPath,
    attachMention,
    mentionPaths: () => mentionCache,
    requestMentions: () => void collectMentions(),
  };
}
