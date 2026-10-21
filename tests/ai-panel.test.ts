import { describe, expect, it } from 'vitest';

import { aiPanelPlan, type AiPanelState } from '../src/shared/ai-panel';

const base: AiPanelState = {
  wasEnabled: true,
  isEnabled: true,
  chatInEditor: false,
  rightVisible: true,
  wantedRightVisible: true,
};

const plan = (patch: Partial<AiPanelState>) => aiPanelPlan({ ...base, ...patch });

describe('aiPanelPlan', () => {
  it('тумблер не трогали — ничего не делает', () => {
    // Повторное применение настроек (тема, шрифт) не должно пересобирать макет:
    // человек мог свернуть панель руками, и это не отменяется.
    expect(plan({ rightVisible: false })).toEqual({
      toggle: 'unchanged',
      hide: false,
      moveChatToPanel: false,
      show: false,
    });
    expect(plan({ wasEnabled: false, isEnabled: false })).toMatchObject({ toggle: 'unchanged', hide: false });
  });

  it('выключение гасит панель', () => {
    expect(plan({ isEnabled: false })).toMatchObject({ toggle: 'disabled', hide: true });
  });

  it('выключение уводит чат из редактора', () => {
    expect(plan({ isEnabled: false, chatInEditor: true })).toMatchObject({
      hide: true,
      moveChatToPanel: true,
    });
  });

  it('выключение не зовёт возврат чата, если он и так в панели', () => {
    expect(plan({ isEnabled: false, chatInEditor: false })).toMatchObject({ moveChatToPanel: false });
  });

  it('выключение не показывает панель — даже если по настройкам она «видна»', () => {
    // Главная ловушка: `setChatInEditor(false)` внутри распахивает панель. Порядок
    // «сперва скрыть, потом уводить чат» — единственный, при котором нет скачка.
    const p = plan({ isEnabled: false, chatInEditor: true, wantedRightVisible: true });
    expect(p.show).toBe(false);
    expect(p.hide).toBe(true);
  });

  it('включение возвращает панель, если она была видна по настройкам', () => {
    expect(plan({ wasEnabled: false, rightVisible: false, wantedRightVisible: true })).toMatchObject({
      toggle: 'enabled',
      show: true,
      hide: false,
    });
  });

  it('включение не распахивает панель, которую человек не держал открытой', () => {
    expect(plan({ wasEnabled: false, rightVisible: false, wantedRightVisible: false })).toMatchObject({
      toggle: 'enabled',
      show: false,
    });
  });

  it('включение не трогает уже видимую панель', () => {
    expect(plan({ wasEnabled: false, rightVisible: true })).toMatchObject({ show: false, hide: false });
  });

  it('включение молчит, если чат живёт вкладкой в редакторе', () => {
    // Второе окно того же диалога справа — хуже, чем ничего.
    expect(plan({ wasEnabled: false, rightVisible: false, chatInEditor: true })).toMatchObject({
      toggle: 'enabled',
      show: false,
      moveChatToPanel: false,
    });
  });

  it('выключение и включение несовместимы в одном плане', () => {
    for (const isEnabled of [true, false]) {
      for (const chatInEditor of [true, false]) {
        for (const rightVisible of [true, false]) {
          const p = plan({ wasEnabled: !isEnabled, isEnabled, chatInEditor, rightVisible });
          expect(p.hide && p.show).toBe(false);
        }
      }
    }
  });
});
