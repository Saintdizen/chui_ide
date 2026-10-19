import { describe, expect, it } from 'vitest';
import {
  MAX_REVIEW_REASON,
  REVIEW_SYSTEM_PROMPT,
  buildReviewPrompt,
  parseReviewVerdict,
  shouldReview,
} from '../src/shared/approval-review';

/**
 * Разбор ответа проверяющего и решение «спрашивать ли его вообще».
 *
 * Главное свойство, которое здесь стережётся, — отказ в сторону вопроса: всё
 * непонятное ведёт к карточке для человека, а не к молчаливому разрешению.
 * Модель могла ответить не по форме, промолчать или назвать оба решения сразу.
 */

describe('разбор ответа проверяющего', () => {
  it('разрешение и вопрос читаются вместе с причиной', () => {
    expect(parseReviewVerdict('ALLOW: только чтение, git status')).toEqual({
      decision: 'allow',
      reason: 'только чтение, git status',
    });
    expect(parseReviewVerdict('ASK: команда ставит пакеты в систему')).toEqual({
      decision: 'ask',
      reason: 'команда ставит пакеты в систему',
    });
  });

  it('регистр и тире перед причиной не важны', () => {
    expect(parseReviewVerdict('allow - просмотр списка').decision).toBe('allow');
    expect(parseReviewVerdict('  Allow — сборка проекта  ')).toEqual({
      decision: 'allow',
      reason: 'сборка проекта',
    });
  });

  it('пустой ответ — вопрос человеку', () => {
    expect(parseReviewVerdict('')).toEqual({ decision: 'ask', reason: 'проверяющий промолчал' });
    expect(parseReviewVerdict('   \n  ').decision).toBe('ask');
  });

  it('ответ не по форме — вопрос человеку', () => {
    for (const answer of [
      'Думаю, можно выполнить',
      'Да',
      '{"decision":"allow"}',
      'Конечно, ALLOW, потому что это чтение',
    ]) {
      expect(parseReviewVerdict(answer), answer).toMatchObject({ decision: 'ask' });
    }
  });

  it('отрицание перед словом не читается как разрешение', () => {
    // «не ALLOW» — это не разрешение, и разбор не должен обмануться словом в тексте.
    expect(parseReviewVerdict('не ALLOW: команда пишет в файл').decision).toBe('ask');
  });

  it('оба решения в ответе — вопрос человеку', () => {
    expect(parseReviewVerdict('ALLOW: чтение\nASK: но лучше спросить').decision).toBe('ask');
  });

  it('причина без текста не ломает разбор', () => {
    expect(parseReviewVerdict('ALLOW:')).toEqual({ decision: 'allow', reason: 'без пояснения' });
    expect(parseReviewVerdict('ASK:   ')).toEqual({ decision: 'ask', reason: 'без пояснения' });
  });

  it('длинная причина обрезается, а переводы строк схлопываются', () => {
    const verdict = parseReviewVerdict(`ALLOW: ${'очень '.repeat(80)}\n\nвторая строка`);
    expect(verdict.decision).toBe('allow');
    expect(verdict.reason.length).toBeLessThanOrEqual(MAX_REVIEW_REASON);
    expect(verdict.reason).not.toContain('\n');
  });
});

describe('стоит ли спрашивать проверяющего', () => {
  const off = { enabled: false, dangerous: false };
  const on = { enabled: true, dangerous: false };

  it('выключенная проверка не спрашивает ни о чём', () => {
    expect(shouldReview('ls -la', off)).toBe(false);
  });

  it('обычная команда проверяется', () => {
    expect(shouldReview('ls -la', on)).toBe(true);
    expect(shouldReview('npm run lint', on)).toBe(true);
    expect(shouldReview('git status --short', on)).toBe(true);
  });

  it('необратимая команда идёт к человеку мимо модели', () => {
    expect(shouldReview('rm -rf build', { enabled: true, dangerous: true })).toBe(false);
    expect(shouldReview('sudo pacman -Syu', { enabled: true, dangerous: true })).toBe(false);
  });

  it('пустая и слишком длинная команда не проверяются', () => {
    expect(shouldReview('   ', on)).toBe(false);
    expect(shouldReview(`echo ${'a'.repeat(2500)}`, on)).toBe(false);
  });
});

describe('запрос к проверяющему', () => {
  it('несёт команду и проект', () => {
    const prompt = buildReviewPrompt('  npm test  ', '/home/user/project');
    expect(prompt).toContain('Проект: /home/user/project');
    expect(prompt).toContain('npm test');
  });

  it('без проекта остаётся одна команда', () => {
    expect(buildReviewPrompt('ls')).toBe('Команда:\nls');
  });

  it('системная часть требует ровно одну строку и склоняет к вопросу', () => {
    expect(REVIEW_SYSTEM_PROMPT).toContain('ALLOW:');
    expect(REVIEW_SYSTEM_PROMPT).toContain('ASK:');
    expect(REVIEW_SYSTEM_PROMPT).toContain('Сомневаешься — отвечай ASK');
  });
});
