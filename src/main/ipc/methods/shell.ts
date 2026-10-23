import path from 'node:path';
import { spawn } from 'node:child_process';
import { shell } from 'electron';
import type { SettingsPatch } from '../../../shared/api';
import { knownLinuxTerminals, pickExternalTerminal } from '../../../shared/external-terminal';
import { isOnPath } from '../../lsp/detect';
import type { RpcServices } from '../context';
import type { RpcRouter } from '../router';

/**
 * Окружение рабочего стола: системный браузер, файлы в проводнике системы,
 * терминал в папке проекта, встроенный браузер (отдельный слой окна) и сам
 * файл настроек.
 *
 * Общее у них одно: все они про переход за границу окна IDE.
 *
 * Перенесено из `register.ts` без правок логики.
 */
export function registerShellMethods(router: RpcRouter, deps: RpcServices): void {
  // Открыть ссылку в браузере системы: адреса площадки живут вне окна IDE.
  router.register('shell.openExternal', async (params) => {
    const url = String(params.url ?? '');
    // Только http(s): ссылка приходит из модели, но открывать произвольную схему незачем.
    if (!/^https?:\/\//i.test(url)) return { ok: false };
    await shell.openExternal(url).catch(() => undefined);
    return { ok: true };
  });

  // Показать объект в проводнике системы и открыть файл программой по умолчанию:
  // работа с файлами продолжается и за пределами окна IDE.
  router.register('shell.revealInOS', (params) => {
    const target = String(params.path ?? '');
    if (!target) return { ok: false };
    shell.showItemInFolder(target);
    return { ok: true };
  });
  router.register('shell.openPath', async (params) => {
    const target = String(params.path ?? '');
    if (!target) return { ok: false };
    // openPath отвечает строкой ошибки: пусто — файл открылся.
    return { ok: (await shell.openPath(target).catch(() => 'ошибка')) === '' };
  });

  /* Встроенный браузер. Вложение живёт не в DOM, а отдельным слоем окна, поэтому
   место ему задаётся числами: прямоугольник области редактора меряет renderer. */
  router.register('browser.viewCreate', (params) => {
    const panel = deps.browserPanel;
    if (!panel) return { ok: false, reason: 'Браузер недоступен' };
    return panel.create(params.id, params.url);
  });
  router.register('browser.viewShow', (params) => {
    const panel = deps.browserPanel;
    if (!panel) return { ok: false };
    return panel.show(params.id, params.rect);
  });
  // Спрятать вложение нужно и тогда, когда страница никуда не делась: палитра,
  // окна и уведомления лежат в DOM, а слой вложения перекрывает их.
  router.register('browser.viewHide', () => {
    deps.browserPanel?.hide();
    return { ok: true };
  });
  router.register('browser.viewLayout', (params) => {
    deps.browserPanel?.layout(params.rect);
    return { ok: true };
  });
  router.register('browser.viewCommand', (params) => {
    const panel = deps.browserPanel;
    if (!panel) return { ok: false, reason: 'Браузер недоступен' };
    return panel.command(params.id, params.action, params.url);
  });
  router.register('browser.viewClose', (params) => {
    deps.browserPanel?.close(params.id);
    return { ok: true };
  });
  router.register('browser.viewCloseAll', () => {
    deps.browserPanel?.closeAll();
    return { ok: true };
  });
  // Общий доступ к вкладке: без него агент работает только в своей сессии, а
  // поделившись — в этой же странице, вместе с её логином и куками.
  router.register('browser.viewShare', (params) => deps.browserPanel?.share(params.id) ?? { ok: false });
  router.register('browser.viewUnshare', () => {
    deps.browserPanel?.unshare();
    return { ok: true };
  });
  // Страница — слой окна, а не элемент документа: снять её и прочитать консоль
  // может только main, поэтому эти два запроса тоже идут сюда.
  router.register('browser.viewCapture', (params) => {
    const panel = deps.browserPanel;
    if (!panel) return { ok: false, reason: 'Браузер недоступен' };
    return panel.capture(params.id);
  });
  router.register('browser.viewConsole', (params) => {
    const panel = deps.browserPanel;
    if (!panel) return { ok: false, lines: [] };
    return { ok: true, lines: panel.consoleLines(params.id) };
  });
  // Масштаб страницы: и кнопки шапки, и Ctrl+колесо, и агент ходят одним путём.
  // «Вписать» считается на странице, поэтому ответ асинхронный.
  router.register('browser.viewZoom', async (params) => {
    const panel = deps.browserPanel;
    if (!panel) return { ok: false, reason: 'Браузер недоступен' };
    return panel.zoom(params.id, params.mode);
  });
  // Выбор элемента мышью: режим выбора живёт на самой странице (в renderer'е нет
  // ни её DOM, ни возможности что-то на ней подсветить), а сюда приходит ответ.
  router.register('browser.viewPick', async (params) => {
    const panel = deps.browserPanel;
    if (!panel) return { ok: false, reason: 'Браузер недоступен' };
    return panel.pick(params.id);
  });

  // Терминал системы в папке проекта: привычный человеку терминал — за окном IDE.
  // Рабочий каталог ставим процессу: не всякий терминал умеет «откройся здесь» доводом.
  router.register('shell.openTerminal', async (params) => {
    const target = String(params.path ?? '');
    if (!target) return { ok: false };
    // Границу рабочей области проверяет `stat`: терминал открываем только внутри проекта.
    const entry = await deps.workspace.stat(target);
    const dir = entry.kind === 'directory' ? entry.path : path.dirname(entry.path);

    // Доступные команды ищем в PATH. Свой выбор человека (`$TERMINAL`) идёт первым.
    const commands = new Set<string>();
    for (const command of [process.env.TERMINAL, ...knownLinuxTerminals(), 'open', process.env.ComSpec ?? 'cmd.exe']) {
      if (!command) continue;
      if (await isOnPath(command)) commands.add(command);
    }

    const launch = pickExternalTerminal(
      process.platform as 'linux' | 'darwin' | 'win32',
      dir,
      (command) => commands.has(command),
      { preferred: process.env.TERMINAL, comspec: process.env.ComSpec },
    );
    if (!launch) return { ok: false };

    try {
      // Отдельный процесс: IDE его не ждёт и не убьёт вместе с собой при закрытии.
      const child = spawn(launch.command, [...launch.args], { cwd: dir, detached: true, stdio: 'ignore' });
      child.unref();
      return { ok: true, command: launch.command };
    } catch {
      return { ok: false };
    }
  });

  router.register('settings.get', () => deps.settings.get());
  router.register('settings.update', (patch: SettingsPatch) => deps.settings.update(patch));
  router.register('settings.revealFile', async () => {
    const file = deps.settings.file();
    await shell.openPath(file).catch(() => undefined);
    return { path: file };
  });
}
