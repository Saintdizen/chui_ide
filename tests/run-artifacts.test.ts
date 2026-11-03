import { describe, expect, it } from 'vitest';

import { createRunArtifacts, MAX_RUN_ARTIFACTS } from '../src/renderer/core/artifacts';

describe('список артефактов прогона', () => {
  it('свежие сверху, повтор не плодит строк', () => {
    const artifacts = createRunArtifacts(() => 1);
    artifacts.add([{ path: '/p/a.ts' }, { path: '/p/b.ts', note: 'отчёт' }]);
    artifacts.add([{ path: '/p/a.ts', note: 'ещё раз' }]);

    expect(artifacts.list().map((item) => item.path)).toEqual(['/p/a.ts', '/p/b.ts']);
    expect(artifacts.list()[0]?.note).toBe('ещё раз');
  });

  it('длинный список не растёт бесконечно', () => {
    const artifacts = createRunArtifacts(() => 1);
    const many = Array.from({ length: MAX_RUN_ARTIFACTS + 10 }, (_, at) => ({ path: `/p/${at}.ts` }));
    artifacts.add(many);

    expect(artifacts.list()).toHaveLength(MAX_RUN_ARTIFACTS);
  });

  it('переключение вкладки подменяет список, а не смешивает', () => {
    const artifacts = createRunArtifacts(() => 1);
    artifacts.add([{ path: '/p/a.ts' }]);
    artifacts.set([{ path: '/p/c.ts', note: 'отчёт', at: 5 }]);

    expect(artifacts.list().map((item) => item.path)).toEqual(['/p/c.ts']);
  });

  it('подписка зовётся только когда список правда изменился', () => {
    const artifacts = createRunArtifacts(() => 1);
    let calls = 0;
    artifacts.onChange(() => {
      calls += 1;
    });

    artifacts.set([]);
    artifacts.clear();
    artifacts.add([{ path: '/p/a.ts' }]);
    artifacts.set([{ path: '/p/a.ts', note: '', at: 1 }]);

    expect(calls).toBe(1);
  });
});
