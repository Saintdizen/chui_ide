import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { beforeEach, describe, expect, it } from 'vitest';
import { ChatStore } from '../src/main/ai/chat-store';
import type { ChatConversation, ChatHistory } from '../src/shared/api';
import { MAX_CONVERSATIONS, MAX_MESSAGES } from '../src/shared/chat-sanitize';

/**
 * Хранилище бесед: единственное место, где лента разговора становится файлом
 * и возвращается обратно. Проверяем не разбор (он в `shared/chat-sanitize.ts`
 * и покрыт отдельно), а саму запись: куда, как и что будет, если файла нет
 * или он испорчен.
 */
let dir: string;
let store: ChatStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), 'chui-chats-'));
  store = new ChatStore(dir);
});

function conversation(uid: string, text = 'привет'): ChatConversation {
  return { uid, title: `Тема ${uid}`, updatedAt: 7, messages: [{ role: 'user', content: text }] };
}

async function files(): Promise<string[]> {
  return (await fs.readdir(dir)).sort();
}

describe('ChatStore: чтение', () => {
  it('в пустом каталоге — пустая история и ни одного файла', async () => {
    expect(await store.load('/tmp/проект')).toEqual({ conversations: [] });
    expect(await files()).toEqual([]);
  });

  it('без рабочей папки не трогает диск', async () => {
    expect(await store.load('')).toEqual({ conversations: [] });
    expect(await files()).toEqual([]);
  });

  it('битый JSON — пустая история, а не отказ панели', async () => {
    const root = '/tmp/сломанный';
    await fs.writeFile(store.fileForRoot(root), '{"conversations": [{"uid": ', 'utf8');
    expect(await store.load(root)).toEqual({ conversations: [] });
  });

  it('мусор в беседе чистится проверкой, а не попадает в ленту', async () => {
    const root = '/tmp/мусор';
    const raw = {
      conversations: [
        null,
        42,
        { uid: '', title: 9, updatedAt: 'вчера', messages: [{ role: 'хакер', content: 'нет' }] },
      ],
      activeUid: 5,
    };
    await fs.writeFile(store.fileForRoot(root), JSON.stringify(raw), 'utf8');

    const history = await store.load(root);
    expect(history.activeUid).toBeUndefined();
    expect(history.conversations).toHaveLength(1);
    expect(history.conversations[0]).toMatchObject({
      uid: 'chat_0',
      title: 'Новая беседа',
      updatedAt: 0,
      messages: [],
    });
  });
});

describe('ChatStore: запись', () => {
  it('круговорот: беседы и активная возвращаются как были', async () => {
    const root = '/tmp/круговорот';
    const history: ChatHistory = { conversations: [conversation('a'), conversation('b')], activeUid: 'b' };

    await store.save(root, history);
    expect(await store.load(root)).toEqual(history);
  });

  it('после записи остаётся ровно один файл: временный переименован', async () => {
    await store.save('/tmp/один', { conversations: [conversation('a')] });
    const names = await files();
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^один-[0-9a-f]{12}\.json$/);
  });

  it('повторная запись заменяет историю, а не дописывает', async () => {
    const root = '/tmp/замена';
    await store.save(root, { conversations: [conversation('старая')] });
    await store.save(root, { conversations: [conversation('новая')] });

    const history = await store.load(root);
    expect(history.conversations.map((c) => c.uid)).toEqual(['новая']);
    expect(await files()).toHaveLength(1);
  });

  it('без рабочей папки ничего не пишет', async () => {
    await store.save('', { conversations: [conversation('a')] });
    expect(await files()).toEqual([]);
  });

  it('чистит то, что сохраняет: лишние беседы, пустое поле и длинную переписку', async () => {
    const long: ChatConversation = {
      ...conversation('длинная'),
      messages: Array.from({ length: MAX_MESSAGES + 5 }, () => ({ role: 'user' as const, content: 'у' })),
    };
    const many = Array.from({ length: MAX_CONVERSATIONS + 3 }, (_, i) => conversation(`c${i}`));
    const dirty = { conversations: [long, ...many], activeUid: '' } as ChatHistory;

    await store.save('/tmp/чистка', dirty);
    const history = await store.load('/tmp/чистка');
    expect(history.activeUid).toBeUndefined();
    expect(history.conversations).toHaveLength(MAX_CONVERSATIONS);
    expect(history.conversations[0]!.messages).toHaveLength(MAX_MESSAGES);
  });
});

describe('ChatStore: имя файла', () => {
  it('одинаково названные папки не затирают друг друга', () => {
    const first = store.fileForRoot('/home/аня/проект');
    const second = store.fileForRoot('/home/петя/проект');

    expect(path.basename(first)).toMatch(/^проект-/);
    expect(path.basename(second)).toMatch(/^проект-/);
    expect(first).not.toBe(second);
  });

  it('один и тот же путь даёт одно и то же имя', () => {
    expect(store.fileForRoot('/tmp/путь/')).toBe(store.fileForRoot('/tmp/путь'));
  });

  it('недопустимые символы заменяются, а кириллица остаётся', () => {
    const name = path.basename(store.fileForRoot('/tmp/мой проект!@#'));
    expect(name).toMatch(/^мой_проект_-[0-9a-f]{12}\.json$/);
  });

  it('папка без имени даёт workspace', () => {
    const name = path.basename(store.fileForRoot(path.parse(process.cwd()).root));
    expect(name).toMatch(/^workspace-[0-9a-f]{12}\.json$/);
  });

  it('по умолчанию лежит рядом с настройками: userData/chats', () => {
    const file = new ChatStore().fileForRoot('/tmp/по-умолчанию');
    expect(path.dirname(file)).toBe(path.join(app.getPath('userData'), 'chats'));
  });
});

describe('ChatStore: файлы, названные по-старому', () => {
  /** Прежнее имя: `\w` в JS знает только латиницу, поэтому кириллица вырезалась. */
  function legacyPath(root: string): string {
    const resolved = path.resolve(root);
    const hash = createHash('sha1').update(resolved).digest('hex').slice(0, 12);
    const safe =
      path
        .basename(resolved)
        .replace(/[^\w.-]+/g, '_')
        .slice(0, 40) || 'workspace';
    return path.join(dir, `${safe}-${hash}.json`);
  }

  it('история из старого файла всё равно читается', async () => {
    const root = '/tmp/старый проект';
    await fs.writeFile(legacyPath(root), JSON.stringify({ conversations: [conversation('давняя')] }), 'utf8');

    const history = await store.load(root);
    expect(history.conversations.map((c) => c.uid)).toEqual(['давняя']);
  });

  it('первая же запись переезжает на читаемое имя и убирает старое', async () => {
    const root = '/tmp/старый проект';
    const legacy = legacyPath(root);
    await fs.writeFile(legacy, JSON.stringify({ conversations: [conversation('давняя')] }), 'utf8');

    await store.save(root, await store.load(root));
    expect(await files()).toEqual([path.basename(store.fileForRoot(root))]);
    expect(await store.load(root)).toEqual({ conversations: [conversation('давняя')] });
  });

  it('у латинского проекта старое и новое имя совпадают — файл не удаляется вместе с историей', async () => {
    const root = '/tmp/latin-project';
    expect(store.fileForRoot(root)).toBe(legacyPath(root));

    await store.save(root, { conversations: [conversation('a')] });
    expect(await files()).toHaveLength(1);
    expect((await store.load(root)).conversations).toHaveLength(1);
  });

  it('у корня без имени старое имя тоже workspace', () => {
    const root = path.parse(process.cwd()).root;
    expect(path.basename(legacyPath(root))).toMatch(/^workspace-[0-9a-f]{12}\.json$/);
  });

  it('сохранение без поля conversations не падает, а пишет пустую историю', async () => {
    await store.save('/tmp/пусто', {} as ChatHistory);
    expect(await store.load('/tmp/пусто')).toEqual({ conversations: [] });
  });
});
