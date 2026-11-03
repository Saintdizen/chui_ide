import { describe, expect, it } from 'vitest';
import { announceMessage, announceTitle, runEnd, shouldRefocus, tailOf } from '../src/renderer/ui/chat-notify';

/**
 * Конец прогона: заметка вместо системного окна.
 *
 * Главное правило: при «готово» и видимой ленте — МОЛЧАТЬ. Заметка перекрыла бы
 * ответ, который человек как раз читает.
 */

describe('уведомление о конце прогона', () => {
  it('busy и unavailable — не конец прогона, а отказ от него', () => {
    expect(runEnd('busy')).toBeUndefined();
    expect(runEnd('unavailable')).toBeUndefined();
  });

  it('done и started — это «ответ готов»', () => {
    expect(runEnd('done')).toBe('done');
    expect(runEnd('started')).toBe('done');
    expect(runEnd('stopped')).toBe('stopped');
    expect(runEnd('failed')).toBe('failed');
  });

  it('при «готово» и видимой ленте — молчит', () => {
    expect(announceMessage('done', 'Беседа', 'готовый ответ', true)).toBeUndefined();
  });

  it('при «готово», но лента не видна — показывает хвост ответа', () => {
    expect(announceMessage('done', 'Беседа', 'готовый ответ', false)).toBe('Беседа: готовый ответ');
  });

  it('ошибка и остановка говорятся всегда, даже в фокусе', () => {
    expect(announceMessage('failed', 'Беседа', '', true)).toContain('упал');
    expect(announceMessage('stopped', 'Беседа', 'часть ответа', true)).toBe('Беседа: остановлено');
  });

  it('хвост длинного ответа режется', () => {
    const long = 'слово '.repeat(60);
    const message = announceMessage('done', 'Беседа', long, false) ?? '';
    expect(message.length).toBeLessThanOrEqual(120);
  });

  it('пустой хвост не превращается в висящее двоеточие', () => {
    expect(announceMessage('done', '  ', '', false)).toBe('Беседа: ответ готов');
  });

  it('заголовок вкладки короткий и с исходом', () => {
    const title = announceTitle('done', 'Очень длинный вопрос про перенос настроек');
    expect(title.length).toBeLessThanOrEqual(40);
    expect(title).toContain('ответ готов');
    expect(announceTitle('failed', '')).toBe('ошибка');
  });

  it('tailOf берёт последний ответ ассистента, а не вопрос', () => {
    const history = [
      { role: 'user' as const, content: 'вопрос' },
      { role: 'assistant' as const, content: 'ответ' },
      { role: 'user' as const, content: 'ещё вопрос' },
    ];
    expect(tailOf(history)).toBe('ответ');
    expect(tailOf([])).toBe('');
  });
});

describe('фокус в поле после ответа', () => {
  const free = { typed: false, menuOpen: false, windowFocused: true };

  it('возвращается после готового ответа и после ошибки', () => {
    expect(shouldRefocus('done', free)).toBe(true);
    expect(shouldRefocus('failed', free)).toBe(true);
  });

  it('после остановки — нет: человек сам только что нажал стоп', () => {
    expect(shouldRefocus('stopped', free)).toBe(false);
  });

  it('не забирает фокус, если человек уже печатает', () => {
    expect(shouldRefocus('done', { ...free, typed: true })).toBe(false);
  });

  it('не сбрасывает раскрытое меню', () => {
    expect(shouldRefocus('done', { ...free, menuOpen: true })).toBe(false);
  });

  it('не работает в окне без фокуса: там его всё равно никто не увидит', () => {
    expect(shouldRefocus('done', { ...free, windowFocused: false })).toBe(false);
  });
});
