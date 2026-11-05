import { describe, expect, it } from 'vitest';
import { compactionFacts, compactionLines, QUESTION_EXCERPT } from '../src/shared/compaction-facts';

const asked = (content: string) => ({ role: 'user', content });
const answered = (content: string) => ({ role: 'assistant', content });

describe('что попало в сводку', () => {
  it('считает сообщения и вопросы отдельно', () => {
    const facts = compactionFacts([
      asked('первый вопрос'),
      answered('ответ'),
      asked('второй вопрос'),
      answered('ещё ответ'),
    ]);
    expect(facts.messages).toBe(4);
    expect(facts.questions).toBe(2);
    expect(facts.firstQuestion).toBe('первый вопрос');
    expect(facts.lastQuestion).toBe('второй вопрос');
  });

  it('вопрос в одну строку и с сокращением: это подпись, а не содержимое', () => {
    const long = 'а'.repeat(QUESTION_EXCERPT * 2);
    const facts = compactionFacts([asked(`  ${long}\nвторая строка `)]);
    expect(facts.firstQuestion.length).toBe(QUESTION_EXCERPT);
    expect(facts.firstQuestion.endsWith('…')).toBe(true);
    expect(facts.firstQuestion).not.toContain('\n');
  });

  it('один вопрос не повторяется дважды в подписи', () => {
    const lines = compactionLines(compactionFacts([asked('единый вопрос'), answered('ответ')]));
    expect(lines[1]).toBe('о чём: «единый вопрос»');
  });

  it('два вопроса — от и до; файлы — только если они есть', () => {
    const facts = compactionFacts([asked('начало'), answered('…'), asked('конец')], { files: 3 });
    const lines = compactionLines(facts);
    expect(lines[0]).toBe('сообщений: 3 · вопросов: 2');
    expect(lines[1]).toBe('о чём: «начало» … «конец»');
    expect(lines[2]).toBe('затронуто файлов: 3');
  });

  it('беседа без вопросов не выдумывает строку «о чём»', () => {
    const lines = compactionLines(compactionFacts([answered('просто ответ')]));
    expect(lines).toEqual(['сообщений: 1 · вопросов: 0']);
  });
});
