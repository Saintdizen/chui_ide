/**
 * Браузер: открыть, снять снимок, клик, ввод, выполнить выражение, масштаб,
 * закрыть — плюс `browserAction` как вход из таблицы инструментов.
 *
 * Разговор с окном редактора, а не с файлами: всё идёт через `ctx.browser`, и
 * без него каждое действие отвечает «Браузер недоступен». Подтверждение у
 * действий с последствиями одно на всех — `permitBrowser`.
 */

import { formatBrowserSnapshot, type BrowserSnapshot } from '../../shared/browser';
import { missingForAction, optionalBoolean, requireString } from './tool-args';
import type { ToolContext, ToolOutcome } from './tool-context';

async function permitBrowser(ctx: ToolContext, action: string): Promise<ToolOutcome | null> {
  if (!ctx.confirmBrowser)
    return {
      ok: false,
      summary: 'Браузер недоступен: окно редактора не подключено',
    };
  if (ctx.allowAll) return null;
  const allowed = await ctx.confirmBrowser(action);
  if (allowed) return null;
  return {
    ok: false,
    summary: 'Пользователь отклонил действие в браузере',
    detail: 'Пользователь не разрешил это действие. Не повторяй его — предложи другой ход.',
  };
}

/** Снимок страницы в ответ инструмента: текст собирает `shared/browser.ts`. */
function snapshotOutcome(snapshot: BrowserSnapshot, summary: string): ToolOutcome {
  return { ok: true, summary, detail: formatBrowserSnapshot(snapshot) };
}

/** «Страница: Заголовок» — короткая сводка для карточки вызова. */
function pageSummary(snapshot: BrowserSnapshot): string {
  const title = snapshot.title.trim() || snapshot.url;
  return `${title} · элементов: ${snapshot.elements.length}`;
}

/**
 * Действия браузера одним инструментом.
 *
 * Семь отдельных имён стоили семи схем в каждом запросе, а различались только
 * первой строкой описания. Разбор аргументов остался в прежних функциях —
 * здесь только выбор по `action` и отказ на незнакомое действие.
 */
export async function browserAction(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const action = requireString(args, 'action').trim();
  switch (action) {
    case 'snapshot':
      return await browserSnapshot(ctx);
    case 'close':
      return await browserClose(ctx);
    case 'zoom':
      return missingForAction(args, ['mode']) ?? (await browserZoom(ctx, args));
    case 'open':
      return missingForAction(args, ['url']) ?? (await browserOpen(ctx, args));
    case 'click':
      return missingForAction(args, ['ref']) ?? (await browserClick(ctx, args));
    case 'type':
      return missingForAction(args, ['ref', 'text']) ?? (await browserType(ctx, args));
    case 'evaluate':
      return missingForAction(args, ['expression']) ?? (await browserEvaluate(ctx, args));
    default:
      return {
        ok: false,
        summary: `Неизвестное действие браузера: ${action}`,
        detail: 'Допустимые: open, snapshot, click, type, evaluate, zoom, close.',
      };
  }
}

async function browserOpen(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.browser) return { ok: false, summary: 'Браузер недоступен' };
  const url = requireString(args, 'url').trim();
  const denied = await permitBrowser(ctx, `открыть ${url}`);
  if (denied) return denied;

  const snapshot = await ctx.browser.open(url);
  return snapshotOutcome(snapshot, pageSummary(snapshot));
}

async function browserSnapshot(ctx: ToolContext): Promise<ToolOutcome> {
  if (!ctx.browser) return { ok: false, summary: 'Браузер недоступен' };
  const snapshot = await ctx.browser.snapshot();
  return snapshotOutcome(snapshot, pageSummary(snapshot));
}

async function browserClick(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.browser) return { ok: false, summary: 'Браузер недоступен' };
  const ref = requireString(args, 'ref').trim();
  const denied = await permitBrowser(ctx, `нажать элемент ${ref} на странице`);
  if (denied) return denied;

  const snapshot = await ctx.browser.click(ref);
  return snapshotOutcome(snapshot, `нажат ${ref} · ${pageSummary(snapshot)}`);
}

async function browserType(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.browser) return { ok: false, summary: 'Браузер недоступен' };
  const ref = requireString(args, 'ref').trim();
  const text = requireString(args, 'text');
  const submit = optionalBoolean(args, 'submit') ?? false;
  const denied = await permitBrowser(ctx, `ввести текст в поле ${ref}${submit ? ' и отправить форму' : ''}`);
  if (denied) return denied;

  const snapshot = await ctx.browser.type(ref, text, submit);
  return snapshotOutcome(snapshot, `введено в ${ref}${submit ? ' и отправлено' : ''} · ${pageSummary(snapshot)}`);
}

async function browserEvaluate(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.browser) return { ok: false, summary: 'Браузер недоступен' };
  const expression = requireString(args, 'expression');
  const denied = await permitBrowser(ctx, `выполнить на странице: ${expression.slice(0, 120)}`);
  if (denied) return denied;

  const result = await ctx.browser.evaluate(expression);
  return { ok: true, summary: 'выражение выполнено', detail: result };
}

/**
 * Масштаб страницы. Подтверждения не спрашивает: страница не меняется, а масштаб
 * обратим одной кнопкой — и всё равно виден человеку в шапке.
 */
async function browserZoom(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.browser) return { ok: false, summary: 'Браузер недоступен' };
  if (!ctx.browser.zoom) {
    return {
      ok: false,
      summary: 'масштаб доступен только во встроенном браузере',
      detail: 'Сейчас агент работает в отдельном Chromium. Встроенный браузер включается в настройках AI.',
    };
  }
  const mode = requireString(args, 'mode').trim();
  if (mode !== 'in' && mode !== 'out' && mode !== 'fit' && mode !== 'actual') {
    return { ok: false, summary: 'mode должен быть in, out, fit или actual' };
  }

  const result = await ctx.browser.zoom(mode);
  if (!result.ok)
    return {
      ok: false,
      summary: result.reason ?? 'не удалось изменить масштаб',
    };
  const percent = Math.round((result.zoom ?? 1) * 100);
  return {
    ok: true,
    summary: `масштаб ${percent}%`,
    detail: `Страница показана с масштабом ${percent}%.`,
  };
}

async function browserClose(ctx: ToolContext): Promise<ToolOutcome> {
  if (!ctx.browser) return { ok: false, summary: 'Браузер недоступен' };
  // Сессии нет — закрывать нечего: «браузер закрыт» здесь звучало бы как отчёт
  // о сделанном, хотя браузера ещё не было.
  if (ctx.browser.running === false) {
    return {
      ok: true,
      summary: 'браузер не запущен',
      detail: 'Сессии браузера нет — закрывать нечего.',
    };
  }
  await ctx.browser.close();
  return {
    ok: true,
    summary: 'браузер закрыт',
    detail: 'Процесс браузера остановлен, временный профиль удалён.',
  };
}
