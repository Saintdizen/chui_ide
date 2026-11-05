import { describe, expect, it } from 'vitest';
import { CHAT_ACTIONS, parseChatAction } from '../src/shared/chat-actions';

describe('свои команды беседы', () => {
  it('распознаёт команду целиком, а не по префиксу', () => {
    expect(parseChatAction('/compact')?.action.id).toBe('compact');
    // «/newbie» — обычный вопрос, а не `/new` с хвостом: иначе человек,
    // начавший вопрос со слеша, потерял бы текст.
    expect(parseChatAction('/newbie как дела')).toBeNull();
    expect(parseChatAction('/ compact')).toBeNull();
  });

  it('знает все три команды и не путает регистр', () => {
    for (const action of CHAT_ACTIONS) {
      expect(parseChatAction(action.command)?.action.id).toBe(action.id);
      expect(parseChatAction(action.command.toUpperCase())?.action.id).toBe(action.id);
    }
    expect(CHAT_ACTIONS.map((action) => action.id)).toEqual(['compact', 'new', 'fork']);
  });

  it('хвост после команды — имя ветки, и он обрезан по краям', () => {
    expect(parseChatAction('/fork про кеш')?.argument).toBe('про кеш');
    expect(parseChatAction('  /fork   про кеш  ')?.argument).toBe('про кеш');
    expect(parseChatAction('/fork')?.argument).toBe('');
  });

  it('обычный вопрос и команда проекта — не наши', () => {
    expect(parseChatAction('сожми контекст')).toBeNull();
    expect(parseChatAction('/run тесты')).toBeNull();
    expect(parseChatAction('')).toBeNull();
  });
});
