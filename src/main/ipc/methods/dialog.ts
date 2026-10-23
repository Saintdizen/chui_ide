import { dialog } from 'electron';
import { promises as fs } from 'node:fs';
import { MAX_CHAT_IMAGES, RpcErrorCode, type ParamsOf, type PickedImage } from '../../../shared/api';
import { addressProblem, parseFsAddress, type FsAddress } from '../../../shared/fs-address';
import { parseBadgeTheme } from '../../../shared/icon-badges';
import { MAX_OPEN_BYTES } from '../../../shared/large-file';
import { parseThemeFile } from '../../../shared/theme-file';
import { unsavedClosePrompt } from '../../../shared/unsaved';
import { IMAGE_EXTENSIONS, readImageAsDataUrl } from '../../ai/images';
import {
  listDirCommand,
  mkdirCommand,
  moveCommand,
  parseDirListing,
  parseStat,
  readFileCommand,
  RemoteShell,
  removeCommand,
  shellQuote,
  statCommand,
  writeFileCommand,
} from '../../workspace/remote-fs';
import { senderWindow, type RpcServices } from '../context';
import { RpcFailure, type RpcRouter } from '../router';

/**
 * Диалоги системы и удалённые файловые системы.
 *
 * Общее у них — выход за пределы обычной файловой системы и обычного окна:
 * человека спрашивает СИСТЕМНОЕ окно (`dialog`), а в удалённый каталог ходит
 * системный клиент (`ssh`, `wsl`, `docker` — `RemoteShell`).
 *
 * Перенесено из `register.ts` без правок логики.
 */
export function registerDialogMethods(router: RpcRouter, deps: RpcServices): void {
  // Экспорт шаблона: содержимое готовит renderer (там живёт палитра), main пишет файл.
  router.register('theme.export', async (params: ParamsOf<'theme.export'>, ctx) => {
    const result = await dialog.showSaveDialog(senderWindow(ctx), {
      title: 'Сохранить тему',
      defaultPath: params.name,
      filters: [{ name: 'Тема chui_iDE', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { path: null };
    await fs.writeFile(result.filePath, params.contents, 'utf8');
    return { path: result.filePath };
  });

  router.register('dialog.pickFolder', async (params: ParamsOf<'dialog.pickFolder'>) => {
    const result = await dialog.showOpenDialog({
      title: params.title ?? 'Открыть проект',
      properties: ['openDirectory', 'createDirectory'],
    });
    return { path: result.canceled ? null : (result.filePaths[0] ?? null) };
  });

  // Сохранение ПОД ДРУГИМ ИМЕНЕМ (Save As): путь выбирает системный диалог, а не мы.
  // Отдаём ему папку и имя текущего файла — диалог открывается там, где файл лежит,
  // а имя можно править, а не набирать заново. Подтверждение перезаписи уже
  // существующего файла диалог берёт на себя сам.
  router.register('dialog.saveFile', async (params: ParamsOf<'dialog.saveFile'>, ctx) => {
    const result = await dialog.showSaveDialog(senderWindow(ctx), {
      title: params.title ?? 'Сохранить как',
      defaultPath: params.defaultPath,
    });
    return { path: result.canceled ? null : (result.filePath ?? null) };
  });

  // Картинки читает main: renderer файловой системы не видит, и получать доступ
  // к ней ради вложения в чат ему незачем. Файлы отдаём сразу data-URL —
  // в таком виде их понимает и <img> в интерфейсе, и OpenAI-совместимый API.
  router.register('dialog.pickImages', async (_params, ctx) => {
    const result = await dialog.showOpenDialog(senderWindow(ctx), {
      title: 'Приложить изображение',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Изображения', extensions: IMAGE_EXTENSIONS }],
    });
    if (result.canceled) return [];

    const picked: PickedImage[] = [];
    for (const file of result.filePaths.slice(0, MAX_CHAT_IMAGES)) {
      const image = await readImageAsDataUrl(file).catch(() => null);
      if (image) picked.push(image);
    }
    return picked;
  });

  // Подтверждение спрашиваем системным диалогом: он модальный для окна
  // и не даёт случайно подтвердить разрушительное действие вводом с клавиатуры.
  router.register('dialog.confirm', async (params, ctx) => {
    const { response } = await dialog.showMessageBox(senderWindow(ctx), {
      type: 'warning',
      title: params.title,
      message: params.message,
      detail: params.detail,
      buttons: [params.confirmLabel ?? 'Продолжить', 'Отмена'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    return { confirmed: response === 0 };
  });

  // Закрытие окна с несохранёнными файлами. Диалог системный и модальный: тут
  // нужен выбор из трёх исходов, и «Сохранить» — единственный путь без потерь.
  router.register('dialog.confirmClose', async (params, ctx) => {
    const prompt = unsavedClosePrompt(params.files);
    const { response } = await dialog.showMessageBox(senderWindow(ctx), {
      type: 'warning',
      title: 'Несохранённые файлы',
      message: prompt.message,
      detail: prompt.detail,
      buttons: ['Сохранить', 'Выйти без сохранения', 'Отмена'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    const choice: 'save' | 'discard' | 'cancel' = response === 0 ? 'save' : response === 1 ? 'discard' : 'cancel';
    return { choice };
  });

  // Тема из файла: диалог и чтение — в main, renderer файловой системы не видит.
  // Разбор — общим кодом (`shared/theme-file`): та же проверка, что при чтении настроек.
  router.register('theme.import', async (_params, ctx) => {
    const result = await dialog.showOpenDialog(senderWindow(ctx), {
      title: 'Импортировать тему',
      properties: ['openFile'],
      filters: [{ name: 'Тема chui_iDE', extensions: ['json'] }],
    });
    const file = result.filePaths[0];
    if (result.canceled || !file) return { settings: deps.settings.get(), name: null };
    const text = await fs.readFile(file, 'utf8');
    const parsed = parseThemeFile(text);
    if (!parsed.ok) throw new RpcFailure(RpcErrorCode.InvalidParams, parsed.error);
    return {
      settings: deps.settings.update({ appearance: { customTheme: parsed.theme } }),
      name: parsed.theme.name,
    };
  });

  router.register('theme.clear', () => deps.settings.update({ appearance: { customTheme: null } }));

  // Удалённые файловые системы: адрес разбирается общим кодом, а ходит туда клиент
  // системы (`ssh`, `wsl`, `docker`). Ошибку клиента возвращаем как есть — человеку
  // по ней понятно, ключ это, сеть или опечатка в адресе.
  const remote = new RemoteShell();
  const remoteAddress = (value: string): FsAddress => {
    const address = parseFsAddress(value);
    if (!address) {
      throw new RpcFailure(RpcErrorCode.InvalidParams, addressProblem(value) ?? 'Не разобрать адрес');
    }
    return address;
  };
  const remoteFail = (result: { stderr: string; stdout: string }, what: string): never => {
    throw new RpcFailure(RpcErrorCode.Internal, result.stderr.trim() || result.stdout.trim() || `Не удалось ${what}`);
  };

  // Проверка адреса — в два шага. Сперва есть ли клиент (без `ssh`/`wsl`/`docker`
  // ходить нечем), потом пускают ли по адресу и на месте ли путь: без второго шага
  // «подключено» обещало бы больше, чем есть, а опечатка в хосте всплыла бы позже,
  // пустой папкой. Просим у той стороны всего лишь `cd` и `pwd`.
  router.register('remote.check', async (params) => {
    const address = remoteAddress(params.address);
    const client = await remote.available(address);
    if (!client.ok) return client;
    const probe = await remote.run(address, `cd ${shellQuote(address.path)} && pwd`);
    if (!probe.ok) {
      return {
        ok: false,
        detail: probe.stderr.trim() || probe.stdout.trim() || 'Не удалось подключиться по адресу',
      };
    }
    return { ok: true, detail: `${client.detail} · ${probe.stdout.trim()}` };
  });

  router.register('remote.readDir', async (params) => {
    const address = remoteAddress(params.address);
    const result = await remote.run(address, listDirCommand(address));
    if (!result.ok) remoteFail(result, 'прочитать папку');
    return parseDirListing(result.stdout, address);
  });

  router.register('remote.readFile', async (params) => {
    const address = remoteAddress(params.address);
    // Читаем не больше MAX_OPEN_BYTES: это тот же потолок, выше которого файл не
    // открывают и локально (`shared/large-file.ts`) — тянуть его по сети тем более незачем.
    const limit = Math.min(Math.max(Math.round(params.maxBytes ?? MAX_OPEN_BYTES), 1), MAX_OPEN_BYTES);
    const result = await remote.run(address, readFileCommand(address, limit));
    if (!result.ok) remoteFail(result, 'прочитать файл');
    const stat = await remote.run(address, statCommand(address));
    const size = stat.ok ? (parseStat(stat.stdout)?.size ?? result.stdout.length) : result.stdout.length;
    return { text: result.stdout, truncated: size > Buffer.byteLength(result.stdout, 'utf8') };
  });

  router.register('remote.writeFile', async (params) => {
    const address = remoteAddress(params.address);
    const result = await remote.run(address, writeFileCommand(address), params.text);
    if (!result.ok) remoteFail(result, 'записать файл');
    return { ok: true };
  });

  router.register('remote.stat', async (params) => {
    const address = remoteAddress(params.address);
    const result = await remote.run(address, statCommand(address));
    const stat = result.ok ? parseStat(result.stdout) : null;
    return stat
      ? { exists: true, kind: stat.kind, size: stat.size, mtimeMs: stat.mtimeMs }
      : { exists: false, kind: 'file' as const, size: 0, mtimeMs: 0 };
  });

  router.register('remote.mkdir', async (params) => {
    const address = remoteAddress(params.address);
    const result = await remote.run(address, mkdirCommand(address));
    if (!result.ok) remoteFail(result, 'создать папку');
    return { ok: true };
  });

  router.register('remote.rename', async (params) => {
    const from = remoteAddress(params.from);
    const to = remoteAddress(params.to);
    const result = await remote.run(from, moveCommand(from, to));
    if (!result.ok) remoteFail(result, 'переименовать');
    return { ok: true };
  });

  router.register('remote.remove', async (params) => {
    const address = remoteAddress(params.address);
    const result = await remote.run(address, removeCommand(address));
    if (!result.ok) remoteFail(result, 'удалить');
    return { ok: true };
  });

  // Набор значков дерева из JSON-файла: диалог и чтение — в main, разбор — общим
  // кодом (`shared/icon-badges`): та же проверка, что при чтении настроек.
  router.register('explorer.importBadges', async (_params, ctx) => {
    const result = await dialog.showOpenDialog(senderWindow(ctx), {
      title: 'Набор значков дерева',
      properties: ['openFile'],
      filters: [{ name: 'Набор значков', extensions: ['json'] }],
    });
    const file = result.filePaths[0];
    if (result.canceled || !file) {
      return { settings: deps.settings.get(), count: deps.settings.get().explorer.badges.length };
    }
    const text = await fs.readFile(file, 'utf8');
    const parsed = parseBadgeTheme(text);
    if (!parsed.ok) throw new RpcFailure(RpcErrorCode.InvalidParams, parsed.error);
    return {
      settings: deps.settings.update({ explorer: { badges: parsed.rules } }),
      count: parsed.rules.length,
    };
  });
}
