import { describe, expect, it } from 'vitest';
import { NoticeRegistry } from '../src/renderer/core/notice-registry';

/**
 * Один канал на одно событие.
 *
 * Было: ошибка всплывала тостом, висела в статус-баре и ждала в «Проблемах»;
 * при повторе в цикле тосты перекрывали друг друга.
 */
function make() {
  let clock = 0;
  const registry = new NoticeRegistry(() => clock);
  return {
    registry,
    tick: (ms = 1) => {
      clock += ms;
    },
  };
}

describe('NoticeRegistry', () => {
  it('первое уведомление показывается и попадает в историю', () => {
    const { registry } = make();
    const outcome = registry.push({ key: 'lsp:ts:crash', text: 'Сервер TS упал', kind: 'error' });
    expect(outcome.toast).toBe(true);
    expect(outcome.repeat).toBe(false);
    expect(registry.history()).toHaveLength(1);
  });

  it('повтор склеивается, а не плодит второе', () => {
    // Главный дефект: цикл переподключения заваливал экран тостами об одном.
    const { registry, tick } = make();
    registry.push({ key: 'lsp:ts:crash', text: 'Сервер TS упал' });
    tick();
    const again = registry.push({ key: 'lsp:ts:crash', text: 'Сервер TS упал' });
    expect(again.repeat).toBe(true);
    expect(again.notice.count).toBe(2);
    expect(registry.history()).toHaveLength(1);
  });

  it('повтор поднимает уведомление в начало журнала и обновляет время', () => {
    const { registry, tick } = make();
    registry.push({ key: 'git:fetch', text: 'Не удалось обновить' });
    tick(10);
    registry.push({ key: 'chat:done', text: 'Ответ готов' });
    tick(10);
    registry.push({ key: 'git:fetch', text: 'Не удалось обновить' });
    expect(registry.history()[0]?.key).toBe('git:fetch');
    expect(registry.history()[0]?.lastAt).toBe(20);
    expect(registry.history()[0]?.firstAt).toBe(0);
  });

  it('повтор снимает отметку «прочитано»: он снова актуален', () => {
    const { registry } = make();
    registry.push({ key: 'lsp:ts:crash', text: 'упал' });
    registry.markSeen('lsp:ts:crash');
    expect(registry.unreadCount()).toBe(0);
    registry.push({ key: 'lsp:ts:crash', text: 'упал' });
    expect(registry.unreadCount()).toBe(1);
  });

  it('«не беспокоить» глушит группу, но история продолжает писаться', () => {
    // Если глушить и историю — человек теряет следы и не сможет вернуться
    // к тому, что пропустил.
    const { registry } = make();
    registry.mute('git');
    const outcome = registry.push({ key: 'git:fetch', text: 'Не удалось' });
    expect(outcome.toast).toBe(false);
    expect(registry.history({ group: 'git' })).toHaveLength(1);
  });

  it('группа по умолчанию — часть ключа до двоеточия', () => {
    const { registry } = make();
    registry.mute('lsp');
    expect(registry.push({ key: 'lsp:ts:crash', text: 'упал' }).toast).toBe(false);
    expect(registry.push({ key: 'git:fetch', text: 'упал' }).toast).toBe(true);
  });

  it('группу можно вернуть', () => {
    const { registry } = make();
    registry.mute('git');
    registry.mute('git', false);
    expect(registry.isMuted('git')).toBe(false);
    expect(registry.push({ key: 'git:fetch', text: 'x' }).toast).toBe(true);
  });

  it('непрочитанное — отдельным счётом, и «прочитать всё» его обнуляет', () => {
    const { registry } = make();
    registry.push({ key: 'a:x', text: 'раз' });
    registry.push({ key: 'b:y', text: 'два' });
    expect(registry.unreadCount()).toBe(2);
    registry.markAllSeen();
    expect(registry.unreadCount()).toBe(0);
    expect(registry.history({ unreadOnly: true })).toHaveLength(0);
    expect(registry.history()).toHaveLength(2);
  });

  it('история не растёт без предела', () => {
    const { registry } = make();
    for (let i = 0; i < 260; i += 1) registry.push({ key: `group:${i}`, text: `#${i}` });
    expect(registry.history().length).toBeLessThanOrEqual(200);
    // Вытесняется СТАРОЕ: свежее на месте.
    expect(registry.history()[0]?.key).toBe('group:259');
  });

  it('очистка стирает журнал, но не настройки глушения', () => {
    const { registry } = make();
    registry.mute('git');
    registry.push({ key: 'git:fetch', text: 'x' });
    registry.clear();
    expect(registry.history()).toHaveLength(0);
    expect(registry.isMuted('git')).toBe(true);
  });

  it('счётчик показывает, сколько раз повторилось', () => {
    const { registry } = make();
    for (let i = 0; i < 5; i += 1) registry.push({ key: 'lsp:ts:crash', text: 'упал' });
    expect(registry.history()[0]?.count).toBe(5);
  });
});

describe('тосты идут через реестр', () => {
  it('вызов с ключом спрашивает реестр: повтор поднимает, а не плодит', () => {
    // Это тот шов, ради которого реестр подключался: `showToast` с ключом
    // пропускает сообщение через реестр, поэтому `git checkout .` на двадцати
    // файлах даёт один тост со счётчиком, а не двадцать поверх ленты.
    const clock = 0;
    const registry = new NoticeRegistry(() => clock);
    const first = registry.push({ key: 'disk-changed:/p/a.ts', text: 'изменился', kind: 'info' });
    const second = registry.push({ key: 'disk-changed:/p/a.ts', text: 'изменился', kind: 'info' });
    expect(first.toast).toBe(true);
    expect(second.repeat).toBe(true);
    expect(second.notice.count).toBe(2);
  });

  it('разные файлы — разные тосты, один файл — один', () => {
    // Ключ по пути, а не общий: иначе двадцатка файлов слилась бы в «×20»,
    // и человек не узнал бы, ЧТО именно поменялось.
    const clock = 0;
    const registry = new NoticeRegistry(() => clock);
    registry.push({ key: 'disk-changed:/p/a.ts', text: 'a', kind: 'info' });
    registry.push({ key: 'disk-changed:/p/b.ts', text: 'b', kind: 'info' });
    expect(registry.history().length).toBe(2);
  });

  it('приглушённая группа не всплывает, но остаётся в истории', () => {
    const clock = 0;
    const registry = new NoticeRegistry(() => clock);
    registry.mute('lsp');
    const outcome = registry.push({ key: 'lsp:no-server', text: 'нет сервера', kind: 'error' });
    expect(outcome.toast).toBe(false);
    // История — для панели «Уведомления»: приглушить показ не значит забыть.
    expect(registry.history().some((notice) => notice.key === 'lsp:no-server')).toBe(true);
  });
});
