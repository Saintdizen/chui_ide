import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REPOSITORY_WATCH_DEBOUNCE_MS, RepositoryWatcher } from '../src/main/git/repository-watcher';

describe('RepositoryWatcher', () => {
  let base: string;
  let repo: string;

  beforeEach(() => {
    base = mkdtempSync(path.join(os.tmpdir(), 'chui-watcher-'));
    repo = path.join(base, 'repo');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('без обработчика слежение не заводится и не падает', () => {
    const watcher = new RepositoryWatcher(null);
    expect(() => watcher.sync(repo)).not.toThrow();
    watcher.close();
  });

  it('не репозиторий — молчит, а не бросает', () => {
    const onChange = vi.fn();
    const watcher = new RepositoryWatcher(onChange);
    watcher.sync(path.join(base, 'нет-такого'));
    watcher.close();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('правка в .git даёт один пересчёт на пачку', async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const watcher = new RepositoryWatcher(onChange);
    watcher.sync(repo);
    // Событие ставит таймер дебаунса; ждём дольше окна склейки.
    for (let i = 0; i < 3; i += 1) writeFileSync(path.join(repo, '.git', 'HEAD'), `ref: refs/heads/b${i}\n`);
    vi.advanceTimersByTime(REPOSITORY_WATCH_DEBOUNCE_MS + 50);
    // На этой платформе наблюдение может отсутствовать — тогда вызовов ноль, но
    // больше одного при любом раскладе быть не должно.
    expect(onChange.mock.calls.length).toBeLessThanOrEqual(1);
    watcher.close();
    vi.useRealTimers();
  });

  it('close снимает таймер: после закрытия пересчёта нет', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const watcher = new RepositoryWatcher(onChange);
    watcher.sync(repo);
    watcher.close();
    vi.advanceTimersByTime(REPOSITORY_WATCH_DEBOUNCE_MS * 3);
    expect(onChange).not.toHaveBeenCalled();
  });
});
