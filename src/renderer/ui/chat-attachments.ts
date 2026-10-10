import {
  type ChatAttachment,
  type DirEntry,
  MAX_CHAT_IMAGES,
  MAX_IMAGE_BYTES,
  type PickedImage,
} from '../../shared/api';
import type { DocumentStore } from '../core/document-store';
import type { EditorService } from '../core/editor-service';
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

/** Каталоги, которые в `@`-подсказку не попадают: шум и вес обхода. */
const MENTION_SKIP = new Set(['node_modules', '.git', 'dist', 'out', '.cache', '__pycache__', '.venv', 'release']);
const MAX_MENTIONS = 4000;

export interface AttachmentsDeps {
  rpc: RpcClient;
  documents: DocumentStore;
  editors: EditorService;
  workspace: WorkspaceModel;
  /** Активная беседа: у каждой вкладки свои вложения. */
  session(): ChatSession;
  /** Вернуть фокус в поле ввода после прикладывания контекста. */
  focus(): void;
}

export interface AttachmentsView {
  /** Полоса чипов: приложенный к вопросу контекст. */
  element: HTMLElement;
  /** Перерисовать чипы активной беседы. */
  render(): void;
  /** Снять вложения перед отправкой: контекст принадлежит конкретному вопросу. */
  takeForSend(): ChatAttachment[];
  /** Приложить то, что открыто в редакторе: выделение, а если его нет — файл. */
  attachBest(): void;
  /** Приложить контекст вида `#`: выделение, файл или пометки языка. */
  attachFrom(kind: 'selection' | 'file' | 'problems'): void;
  /** Выбор изображений системным диалогом. */
  attachImagesFromDialog(): Promise<void>;
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

  function render(): void {
    const attachments = deps.session().attachments;
    clear(element);
    element.hidden = attachments.length === 0;

    attachments.forEach((item, index) => {
      const image = item.kind === 'image' && item.dataUrl ? item : null;
      element.appendChild(
        h(
          'span',
          {
            class: `chip chip-static${image ? ' chip-image' : ''}`,
            title: image
              ? `${item.title} · ${formatBytes(item.bytes ?? 0)}`
              : `${item.title}\n\n${item.text.slice(0, 300)}`,
          },
          // У картинки вместо значка — она сама: по миниатюре видно, что приложено,
          // и не приходится открывать файл, чтобы это проверить.
          image
            ? h('img', { class: 'chip-thumb', src: image.dataUrl!, alt: item.label })
            : svgIcon(item.kind === 'problems' ? 'warning' : 'file', 12),
          h('span', { class: 'chip-name' }, item.label),
          image ? h('span', { class: 'chip-hint' }, formatBytes(item.bytes ?? 0)) : null,
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
        ),
      );
    });
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
    session.attachments = session.attachments.filter((_, position) => position !== index);
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

  /** Выделение, а если его нет — файл целиком. */
  function attachBest(): void {
    if (deps.editors.selectedText().trim()) addAttachment(attachmentFrom('selection'));
    else addAttachment(attachmentFrom('file'));
  }

  /** Собрать вложение по произвольному пути: файл целиком или список папки. */
  async function attachmentFromPath(target: string, kind: 'file' | 'dir'): Promise<ChatAttachment | null> {
    try {
      if (kind === 'dir') {
        const entries = await deps.workspace.readDir(target);
        const list = entries.map((entry) => `${entry.name}${entry.kind === 'directory' ? '/' : ''}`).join('\n');
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

  async function collectMentions(): Promise<void> {
    const root = deps.workspace.root;
    if (!root) {
      mentionCache = [];
      return;
    }

    const result: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 6 || result.length >= MAX_MENTIONS) return;
      let entries: DirEntry[];
      try {
        entries = await deps.workspace.readDir(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (result.length >= MAX_MENTIONS) return;
        const rel = relativePath(root, entry.path);
        if (entry.kind === 'directory') {
          if (MENTION_SKIP.has(entry.name)) continue;
          result.push(`${rel}/`);
          await walk(entry.path, depth + 1);
        } else {
          result.push(rel);
        }
      }
    };
    await walk(root, 0);
    mentionCache = result;
  }

  /** Вложения приложены к конкретному вопросу: при отправке их снимаем и отдаём. */
  function takeForSend(): ChatAttachment[] {
    const session = deps.session();
    const sent = [...session.attachments];
    session.attachments = [];
    render();
    return sent;
  }

  return {
    element,
    render,
    takeForSend,
    attachBest,
    attachFrom: (kind) => addAttachment(attachmentFrom(kind)),
    attachImagesFromDialog,
    attachFiles,
    attachPath,
    attachMention,
    mentionPaths: () => mentionCache,
    requestMentions: () => void collectMentions(),
  };
}
