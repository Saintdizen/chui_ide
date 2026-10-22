import type { WebContents } from 'electron';
import { describe, expect, it } from 'vitest';
import { RpcFailure, RpcRouter } from '../src/main/ipc/router';
import {
  RPC_EVENT_CHANNEL,
  RPC_EVENT_END,
  RpcErrorCode,
  type RpcEventMessage,
  type RpcResult,
} from '../src/shared/api';

/**
 * Развод вызовов в main — без Electron.
 *
 * `RpcRouter.dispatch` — это весь RPC главного процесса: `attach()` лишь
 * подключает его к каналу `chui:rpc:call`. Поэтому отправитель приходит в него
 * напрямую, и здесь проверяется то, на что опирается renderer: код ошибки
 * (а не «что-то упало»), метка конца стрима, порядок событий и учёт вызовов
 * для отмены.
 *
 * Метод для проверок — `shell.openExternal`: у него простые параметры и
 * результат, и он ничего не делает с диском.
 */

interface Sent {
  channel: string;
  message: RpcEventMessage;
}

interface FakeSender {
  sender: WebContents;
  sent: Sent[];
  /** Окно закрылось: события и метка конца должны замолчать. */
  destroy(): void;
}

function fakeSender(): FakeSender {
  const sent: Sent[] = [];
  let destroyed = false;
  const sender = {
    isDestroyed: () => destroyed,
    send: (channel: string, message: RpcEventMessage) => {
      sent.push({ channel, message });
    },
  };
  return {
    sender: sender as unknown as WebContents,
    sent,
    destroy: () => {
      destroyed = true;
    },
  };
}

/** Вызов в том виде, в каком он приходит из renderer'а. */
function call(id: string, method: string, params: unknown = {}, stream = false): unknown {
  return { id, method, params, ...(stream ? { stream: true } : {}) };
}

/** Ошибка ответа: разбор через утверждение, чтобы тип сузился. */
function errorOf(result: RpcResult): { code: number; message: string; details?: string } {
  expect(result.ok, `вызов неожиданно удался: ${JSON.stringify(result)}`).toBe(false);
  if (result.ok) throw new Error('вызов удался');
  return result.error;
}

describe('RpcRouter.dispatch: разбор вызова', () => {
  it('успешный вызов отдаёт значение и передаёт параметры как есть', async () => {
    const router = new RpcRouter();
    const { sender } = fakeSender();
    let seenId = '';
    router.register('shell.openExternal', (params, ctx) => {
      seenId = ctx.id;
      return { ok: params.url.startsWith('https://') };
    });

    const result = await router.dispatch(sender, call('c1', 'shell.openExternal', { url: 'https://example.com' }));

    expect(result).toEqual({ id: 'c1', ok: true, value: { ok: true } });
    // Идентификатор вызова доходит до обработчика: по нему он шлёт события.
    expect(seenId).toBe('c1');
  });

  it('мусор вместо вызова — InvalidParams, а не TypeError', async () => {
    const router = new RpcRouter();
    const { sender } = fakeSender();

    for (const raw of [
      null,
      'строка',
      42,
      {},
      { id: 'c1' },
      { id: 5, method: 'shell.openExternal' },
      { id: '', method: 'x' },
    ]) {
      const result = await router.dispatch(sender, raw);
      // id в ответе пуст: сопоставлять нечего, но renderer получает код, а не падение.
      expect(result, `вызов ${JSON.stringify(raw)}`).toEqual({
        id: '',
        ok: false,
        error: { code: RpcErrorCode.InvalidParams, message: expect.any(String) },
      });
    }
  });
});

describe('RpcRouter.dispatch: ошибки', () => {
  it('RpcFailure доносит свой код и details — иначе причина теряется', async () => {
    const router = new RpcRouter();
    const { sender } = fakeSender();
    router.register('shell.openExternal', () => {
      throw new RpcFailure(RpcErrorCode.InvalidParams, 'Путь вне рабочей папки', 'подробности');
    });

    const result = await router.dispatch(sender, call('c1', 'shell.openExternal', { url: 'https://x' }));

    expect(errorOf(result)).toEqual({
      code: RpcErrorCode.InvalidParams,
      message: 'Путь вне рабочей папки',
      details: 'подробности',
    });
  });

  it('отмена доходит до renderer как Cancelled, а не как Internal', async () => {
    const router = new RpcRouter();
    const { sender } = fakeSender();
    router.register('shell.openExternal', () => {
      const abort = new Error('прервано');
      abort.name = 'AbortError';
      throw abort;
    });

    const result = await router.dispatch(sender, call('c1', 'shell.openExternal', { url: 'https://x' }));

    expect(errorOf(result)).toMatchObject({ code: RpcErrorCode.Cancelled });
  });

  it('неожиданная ошибка становится Internal и уносит стек', async () => {
    const router = new RpcRouter();
    const { sender } = fakeSender();
    router.register('shell.openExternal', () => {
      throw new Error('бум');
    });

    const result = await router.dispatch(sender, call('c1', 'shell.openExternal', { url: 'https://x' }));

    const error = errorOf(result);
    expect(error.code).toBe(RpcErrorCode.Internal);
    expect(error.message).toBe('бум');
    // Стек нужен, чтобы падение в main можно было разобрать по логу.
    expect(error.details).toContain('бум');
  });

  it('брошенное не-исключение тоже отвечает ошибкой', async () => {
    const router = new RpcRouter();
    const { sender } = fakeSender();
    router.register('shell.openExternal', () => {
      throw 'просто строка';
    });

    const result = await router.dispatch(sender, call('c1', 'shell.openExternal', { url: 'https://x' }));

    expect(errorOf(result)).toEqual({ code: RpcErrorCode.Internal, message: 'просто строка' });
  });
});

describe('RpcRouter.dispatch: неизвестный метод', () => {
  it('отвечает MethodNotFound и не будит renderer событиями без стрима', async () => {
    const router = new RpcRouter();
    const { sender, sent } = fakeSender();

    const result = await router.dispatch(sender, call('c1', 'nope.method'));

    expect(result).toEqual({
      id: 'c1',
      ok: false,
      error: { code: RpcErrorCode.MethodNotFound, message: 'Неизвестный метод: nope.method' },
    });
    expect(sent).toEqual([]);
  });

  it('на стримовый вызов всё равно шлёт метку конца', async () => {
    // Без метки renderer ждал бы событий до страховочного срока и держал панель занятой.
    const router = new RpcRouter();
    const { sender, sent } = fakeSender();

    await router.dispatch(sender, call('c1', 'nope.method', {}, true));

    expect(sent).toEqual([{ channel: RPC_EVENT_CHANNEL, message: { id: 'c1', event: RPC_EVENT_END, payload: null } }]);
  });
});

describe('RpcRouter.dispatch: события вызова', () => {
  it('emit уходит в канал событий, а метка конца — после них', async () => {
    const router = new RpcRouter();
    const { sender, sent } = fakeSender();
    router.register('shell.openExternal', (_params, ctx) => {
      ctx.emit('delta', { text: 'раз' });
      ctx.emit('delta', { text: 'два' });
      return { ok: true };
    });

    const result = await router.dispatch(sender, call('c1', 'shell.openExternal', { url: 'https://x' }, true));

    expect(result).toEqual({ id: 'c1', ok: true, value: { ok: true } });
    // Порядок значим: метка объявляет конец, и всё, что после неё, потеряется.
    expect(sent).toEqual([
      { channel: RPC_EVENT_CHANNEL, message: { id: 'c1', event: 'delta', payload: { text: 'раз' } } },
      { channel: RPC_EVENT_CHANNEL, message: { id: 'c1', event: 'delta', payload: { text: 'два' } } },
      { channel: RPC_EVENT_CHANNEL, message: { id: 'c1', event: RPC_EVENT_END, payload: null } },
    ]);
  });

  it('метка конца после ошибки: упавший вызов не оставляет renderer ждать', async () => {
    const router = new RpcRouter();
    const { sender, sent } = fakeSender();
    router.register('shell.openExternal', () => {
      throw new RpcFailure(RpcErrorCode.Internal, 'не вышло');
    });

    await router.dispatch(sender, call('c1', 'shell.openExternal', { url: 'https://x' }, true));

    expect(sent.map((item) => item.message.event)).toEqual([RPC_EVENT_END]);
  });

  it('закрытое окно не получает ни событий, ни метки', async () => {
    const router = new RpcRouter();
    const { sender, sent, destroy } = fakeSender();
    destroy();
    router.register('shell.openExternal', (_params, ctx) => {
      ctx.emit('delta', { text: 'раз' });
      return { ok: true };
    });

    const result = await router.dispatch(sender, call('c1', 'shell.openExternal', { url: 'https://x' }, true));

    // Вызов при этом не падает: работа доводится до ответа, просто её некому слать.
    expect(result).toEqual({ id: 'c1', ok: true, value: { ok: true } });
    expect(sent).toEqual([]);
  });
});

describe('RpcRouter.cancel: отмена по id', () => {
  it('прерывает signal именно этого вызова', async () => {
    const router = new RpcRouter();
    const { sender } = fakeSender();
    let signal: AbortSignal | null = null;
    let release = (): void => undefined;
    router.register('shell.openExternal', (_params, ctx) => {
      signal = ctx.signal;
      return new Promise((resolve) => {
        release = () => resolve({ ok: true });
      });
    });

    const pending = router.dispatch(sender, call('c1', 'shell.openExternal', { url: 'https://x' }));
    router.cancel('c1');
    expect(signal!.aborted).toBe(true);

    release();
    // Отменённый вызов всё равно отвечает — renderer не остаётся без ответа.
    await expect(pending).resolves.toEqual({ id: 'c1', ok: true, value: { ok: true } });
  });

  it('после ответа отменять нечего', async () => {
    const router = new RpcRouter();
    const { sender } = fakeSender();
    router.register('shell.openExternal', () => ({ ok: true }));

    await router.dispatch(sender, call('c1', 'shell.openExternal', { url: 'https://x' }));

    // Запись снимается в `finally`: без этого карта вызовов росла бы весь сеанс.
    expect(() => router.cancel('c1')).not.toThrow();
  });

  it('завершение вызова не снимает чужой вызов с тем же id', async () => {
    // Идентификаторы приходят от renderer'а и могут совпасть: снять запись
    // соседа — значит оставить его вызов без отмены.
    const router = new RpcRouter();
    const { sender } = fakeSender();
    const signals: AbortSignal[] = [];
    const releases: Array<() => void> = [];
    router.register('shell.openExternal', (_params, ctx) => {
      signals.push(ctx.signal);
      return new Promise((resolve) => {
        releases.push(() => resolve({ ok: true }));
      });
    });

    // Обработчик зовётся синхронно внутри dispatch, поэтому оба сигнала уже на месте.
    const first = router.dispatch(sender, call('same', 'shell.openExternal', { url: 'https://x' }));
    const second = router.dispatch(sender, call('same', 'shell.openExternal', { url: 'https://x' }));

    releases[0]!();
    await first;
    router.cancel('same');

    expect(signals[0]!.aborted).toBe(false);
    expect(signals[1]!.aborted).toBe(true);

    releases[1]!();
    await second;
  });
});
