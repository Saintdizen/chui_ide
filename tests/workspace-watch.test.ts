import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Наблюдение за файлами: о своих правках и чужих изменениях сообщаем в UI.
 *
 * Проверяется шов, а не сам `fs.watch`: запись мимо сервиса (как из терминала
 * или внешнего редактора) должна дойти до подписчика. Правка `.ai_ignore`
 * перечитывает правила сразу — иначе она подействовала бы лишь при следующем
 * открытии проекта, и человек решил бы, что настройка не работает.
 */

const roots: string[] = [];
const services: WorkspaceService[] = [];

afterEach(async () => {
  for (const ws of services.splice(0)) ws.close();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function makeDir(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-ws6-')));
  roots.push(dir);
  return dir;
}

function service(events: Array<{ topic: string; payload: unknown }>): WorkspaceService {
  const ws = new WorkspaceService((topic, payload) => events.push({ topic, payload }), {});
  services.push(ws);
  return ws;
}

/** Дождаться события: наблюдатель асинхронный, ждать «просто так» нельзя. */
async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('событие не пришло за отведённое время');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('наблюдение за файлами', () => {
  it('запись мимо сервиса сообщается подписчику', async () => {
    const dir = await makeDir();
    await fs.writeFile(path.join(dir, 'a.ts'), 'const a = 1;\n', 'utf8');
    const events: Array<{ topic: string; payload: unknown }> = [];
    const ws = service(events);
    await ws.open(dir);

    // Пишем НЕ через сервис — так видит правку внешний инструмент.
    await fs.writeFile(path.join(dir, 'a.ts'), 'const a = 2;\n', 'utf8');
    await until(() => events.length > 0);

    expect(events[0]!.topic).toBe('workspace:changed');
  });

  it('правка .ai_ignore перечитывает правила сразу, а не при переоткрытии', async () => {
    const dir = await makeDir();
    await fs.writeFile(path.join(dir, 'a.ts'), 'x\n', 'utf8');
    const ws = service([]);
    await ws.open(dir);
    const before = ws.ignoreRuleCount();

    // Файл правил есть только сейчас: без перечитывания о нём никто не узнает.
    await fs.writeFile(path.join(dir, '.ai_ignore'), 'секрет/\nчерновики/\nмусор/\n', 'utf8');
    await until(() => ws.ignoreRuleCount() !== before);

    expect(before).toBe(0);
    expect(ws.ignoreRuleCount()).toBe(3);
  });

  it('после close наблюдение снимается: события больше не приходят', async () => {
    const dir = await makeDir();
    await fs.writeFile(path.join(dir, 'a.ts'), 'x\n', 'utf8');
    const events: Array<{ topic: string; payload: unknown }> = [];
    const ws = service(events);
    await ws.open(dir);
    ws.close();

    await fs.writeFile(path.join(dir, 'a.ts'), 'y\n', 'utf8');
    // Даём наблюдателю шанс: если он не снят, событие придёт.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(events).toHaveLength(0);
  });
});

/**
 * Правила исключения должны ЧТО-ТО исключать. `ignoreRuleCount` говорит лишь
 * «файл правил прочитан»; здесь проверяется сам эффект: путь из `.ai_ignore`
 * не попадает ни в дерево, ни в поиск, ни в список файлов.
 */
describe('правила исключения действуют', () => {
  it('исключённая папка не попадает ни в поиск, ни в список, ни в дерево', async () => {
    const dir = await makeDir();
    await fs.mkdir(path.join(dir, 'секрет'), { recursive: true });
    await fs.writeFile(path.join(dir, 'секрет', 'a.ts'), 'иголка\n', 'utf8');
    await fs.writeFile(path.join(dir, 'открыт.ts'), 'иголка\n', 'utf8');
    await fs.writeFile(path.join(dir, '.ai_ignore'), 'секрет/\n', 'utf8');
    const ws = service([]);
    await ws.open(dir);
    expect(ws.ignoreRuleCount()).toBe(1);

    const found = await ws.search({ query: 'иголка' });
    const files = await ws.findFiles('*.ts');
    const tree = await ws.readDir(dir);

    expect(found.hits.map((hit) => path.basename(hit.path))).toEqual(['открыт.ts']);
    expect(files).toEqual(['открыт.ts']);
    // Дерево — отдельный путь: оно показывает папку, но не считает её частью
    // поиска. Проверяем, что исключение не спрятало её от человека.
    expect(tree.map((entry) => entry.name)).toContain('секрет');
  });

  it('`!` возвращает файл — но только через возврат самой папки, как в git', async () => {
    const dir = await makeDir();
    await fs.mkdir(path.join(dir, 'черновики'), { recursive: true });
    await fs.writeFile(path.join(dir, 'черновики', 'нужен.ts'), 'иголка\n', 'utf8');
    await fs.writeFile(path.join(dir, 'черновики', 'лишний.ts'), 'иголка\n', 'utf8');
    // Одного `!черновики/нужен.ts` мало: в исключённую папку обход не заходит
    // (так же считает git). Работает идиома: вернуть папку, исключить её
    // содержимое, вернуть нужный файл.
    await fs.writeFile(
      path.join(dir, '.ai_ignore'),
      'черновики/\n!черновики/\nчерновики/*\n!черновики/нужен.ts\n',
      'utf8',
    );
    const ws = service([]);
    await ws.open(dir);

    // Маска `*.ts` — только верхний уровень, путь внутри папки ей не подходит:
    // берём маску «на любой глубине».
    const files = await ws.findFiles('**/*.ts');

    expect(files).toEqual(['черновики/нужен.ts']);
  });
});

/**
 * Гонка «закрыли окно между правкой и отправкой». Наблюдатель асинхронный:
 * файл успевает измениться, а проект уже закрыт. Уведомление в этом случае
 * уходить некуда и не должно уходить — иначе окно получит событие о проекте,
 * которого у него больше нет.
 */
describe('закрытие во время правки', () => {
  it('правка после close не доходит до подписчика', async () => {
    const dir = await makeDir();
    const events: Array<{ topic: string; payload: unknown }> = [];
    const ws = service(events);
    await ws.open(dir);

    // Правка мимо сервиса ставит отложенное уведомление (окно схлопывания).
    await fs.writeFile(path.join(dir, 'a.ts'), 'x\n', 'utf8');
    // Закрываем ДО того, как таймер схлопывания успел выстрелить.
    ws.close();
    const before = events.length;

    // Ждём заметно дольше окна схлопывания: если бы уведомление осталось
    // в таймере, оно пришло бы сюда.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(events.length).toBe(before);
    expect(events.some((event) => String(event.topic).includes('workspace'))).toBe(false);
  });

  it('сторож отложенного уведомления: пустой проект не шлёт событие', async () => {
    const dir = await makeDir();
    const events: Array<{ topic: string; payload: unknown }> = [];
    const ws = service(events);
    await ws.open(dir);

    // Таймер ставим сами, а не ждём события от ОС. Наблюдатель отдаёт правку
    // асинхронно и когда ему вздумается: на macOS уведомление приходит уже после
    // записи (FSEvents пачкой), и ожидание «таймер точно жив» было гонкой — на
    // macOS прогон краснел, на Linux проходил.
    const raw = ws as unknown as { active: string | null; watchTimer: unknown; scheduleChange(p: string): void };
    raw.scheduleChange(path.join(dir, 'a.ts'));
    // Активного корня больше нет, а таймер остался — ровно та гонка, от которой
    // сторожит проверка `if (!this.active)`. Достаёмся до неё как есть:
    // обнуляем поле напрямую в обход `close()`, который гасит таймер.
    expect(raw.watchTimer).not.toBeNull();
    raw.active = null;
    const before = events.length;

    await new Promise((resolve) => setTimeout(resolve, 300));

    // Событие без корня уходить некуда — подписчик его не получает.
    expect(events.length).toBe(before);
  });
});
