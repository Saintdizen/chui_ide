import { describe, expect, it } from 'vitest';
import {
  addComment,
  addThread,
  editLastComment,
  makeComment,
  makeThread,
  plural,
  removeThread,
  reviewCounts,
  reviewSummary,
  sanitizeReview,
  setResolved,
  threadsAt,
  threadsForFile,
  REVIEW_TEXT_MAX,
} from '../src/shared/review';

describe('замечания к коду: создание', () => {
  it('новое замечание — тред с одним сообщением и без пометки «решено»', () => {
    const thread = makeThread('/src/a.ts', 'modified', 12, 'const a = 1;', 'так нельзя', 'вы', 1000);
    expect(thread.path).toBe('/src/a.ts');
    expect(thread.side).toBe('modified');
    expect(thread.line).toBe(12);
    expect(thread.anchor).toBe('const a = 1;');
    expect(thread.resolved).toBe(false);
    expect(thread.comments).toHaveLength(1);
    expect(thread.comments[0]?.text).toBe('так нельзя');
    expect(thread.comments[0]?.createdAt).toBe(1000);
  });

  it('номер строки прижимается к единице', () => {
    expect(makeThread('/a.ts', 'original', 0, '', 'x').line).toBe(1);
    expect(makeThread('/a.ts', 'original', -5, '', 'x').line).toBe(1);
  });

  it('длинный текст и ориентир обрезаются по границе', () => {
    const long = 'я'.repeat(REVIEW_TEXT_MAX + 50);
    const thread = makeThread('/a.ts', 'modified', 1, 'о'.repeat(500), long);
    expect(thread.comments[0]?.text.length).toBe(REVIEW_TEXT_MAX);
    expect(thread.anchor.length).toBe(200);
  });

  it('разные замечания получают разные идентификаторы', () => {
    const a = makeThread('/a.ts', 'modified', 1, '', 'один');
    const b = makeThread('/a.ts', 'modified', 1, '', 'два');
    expect(a.id).not.toBe(b.id);
    expect(a.comments[0]?.id).not.toBe(b.comments[0]?.id);
  });
});

describe('замечания к коду: правка списка', () => {
  const base = [makeThread('/a.ts', 'modified', 3, 'x', 'первое'), makeThread('/a.ts', 'modified', 7, 'y', 'второе')];

  it('тред добавляется, удаляется и не мутирует исходный список', () => {
    const added = addThread(base, makeThread('/a.ts', 'original', 1, 'z', 'третье'));
    expect(added).toHaveLength(3);
    expect(base).toHaveLength(2);
    const removed = removeThread(added, base[0]!.id);
    expect(removed).toHaveLength(2);
    expect(removed.some((thread) => thread.id === base[0]!.id)).toBe(false);
  });

  it('ответ добавляется в конец треда, остальные треды не трогаются', () => {
    const replied = addComment(base, base[0]!.id, makeComment('ответ', 'вы', 2000));
    expect(replied[0]?.comments).toHaveLength(2);
    expect(replied[0]?.comments[1]?.text).toBe('ответ');
    expect(replied[1]?.comments).toHaveLength(1);
  });

  it('тред помечается решённым и снова открытым', () => {
    const resolved = setResolved(base, base[1]!.id, true);
    expect(resolved[1]?.resolved).toBe(true);
    expect(resolved[0]?.resolved).toBe(false);
    expect(setResolved(resolved, base[1]!.id, false)[1]?.resolved).toBe(false);
  });

  it('правится только последнее сообщение треда', () => {
    const replied = addComment(base, base[0]!.id, makeComment('опечятка', 'вы', 3000));
    const fixed = editLastComment(replied, base[0]!.id, 'опечатка');
    expect(fixed[0]?.comments.map((comment) => comment.text)).toEqual(['первое', 'опечатка']);
    // Пустой текст не затирает сообщение.
    expect(editLastComment(replied, base[0]!.id, '   ')[0]?.comments[1]?.text).toBe('опечятка');
  });
});

describe('замечания к коду: отбор и счёт', () => {
  const threads = [
    makeThread('/a.ts', 'modified', 5, 'x', 'один'),
    makeThread('/a.ts', 'original', 2, 'y', 'два'),
    makeThread('/b.ts', 'modified', 1, 'z', 'три'),
  ];

  it('треды файла идут по строке', () => {
    const list = threadsForFile(threads, '/a.ts');
    expect(list.map((thread) => thread.line)).toEqual([2, 5]);
  });

  it('треды одной строки одной стороны отбираются точно', () => {
    expect(threadsAt(threads, '/a.ts', 'modified', 5)).toHaveLength(1);
    expect(threadsAt(threads, '/a.ts', 'original', 5)).toHaveLength(0);
    expect(threadsAt(threads, '/b.ts', 'modified', 1)).toHaveLength(1);
  });

  it('счёт замечаний и сообщений', () => {
    const withReply = addComment(threads, threads[0]!.id, makeComment('ответ', 'вы'));
    const resolved = setResolved(withReply, threads[2]!.id, true);
    expect(reviewCounts(resolved)).toEqual({ open: 2, resolved: 1, comments: 4 });
  });

  it('подпись в шапке меняется от числа замечаний', () => {
    expect(reviewSummary([])).toBe('замечаний нет');
    expect(reviewSummary([threads[0]!])).toBe('1 замечание');
    expect(reviewSummary(threads)).toBe('3 замечания');
    expect(reviewSummary(setResolved(threads, threads[0]!.id, true))).toBe('2 замечания, 1 решено');
  });

  it('русское склонение по числу', () => {
    expect(plural(1, 'замечание', 'замечания', 'замечаний')).toBe('замечание');
    expect(plural(3, 'замечание', 'замечания', 'замечаний')).toBe('замечания');
    expect(plural(11, 'замечание', 'замечания', 'замечаний')).toBe('замечаний');
    expect(plural(22, 'замечание', 'замечания', 'замечаний')).toBe('замечания');
  });
});

describe('замечания к коду: проверка того, что пришло из файла', () => {
  it('читает и массив, и обёртку с версией', () => {
    const thread = makeThread('/a.ts', 'modified', 4, 'x', 'текст');
    expect(sanitizeReview([thread])).toHaveLength(1);
    expect(sanitizeReview({ version: 1, threads: [thread] })).toHaveLength(1);
  });

  it('битое и незнакомое молча отбрасывается', () => {
    const clean = sanitizeReview({
      threads: [
        null,
        'строка',
        { path: '', line: 3, comments: [{ text: 'без пути' }] },
        { path: '/a.ts', comments: [] },
        { path: '/a.ts', side: 'чужое', line: 2, comments: [{ text: 'ок' }] },
      ],
    });
    expect(clean).toHaveLength(1);
    // Незнакомая сторона читается как изменённая — безопасное значение по умолчанию.
    expect(clean[0]?.side).toBe('modified');
    expect(clean[0]?.comments[0]?.author).toBe('вы');
  });

  it('тред без сообщений не сохраняется', () => {
    expect(sanitizeReview({ threads: [{ path: '/a.ts', line: 1, comments: [{ text: '  ' }] }] })).toEqual([]);
  });

  it('пустой и совсем не тот вход дают пустой список, а не отказ', () => {
    expect(sanitizeReview(null)).toEqual([]);
    expect(sanitizeReview(42)).toEqual([]);
    expect(sanitizeReview({})).toEqual([]);
  });

  it('время сообщения приводится к числу', () => {
    const clean = sanitizeReview({
      threads: [{ path: '/a.ts', line: 1, comments: [{ text: 'x', createdAt: 'нет' }] }],
    });
    expect(clean[0]?.comments[0]?.createdAt).toBe(0);
  });
});
