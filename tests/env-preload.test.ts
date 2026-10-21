import { describe, expect, it } from 'vitest';
import { createPreloadPlanner } from '../src/renderer/core/env-preload';
import type { ProjectTools } from '../src/renderer/core/project-tools';

const tools = (over: Partial<ProjectTools> = {}): ProjectTools =>
  ({
    root: '/p',
    packageManager: 'npm',
    pythonCommand: 'python3',
    pythonLabel: 'python3',
    pythonFromProject: false,
    nodeVersion: '20.11.0',
    scripts: [],
    hasPackageJson: true,
    tsRunner: null,
    ...over,
  }) as ProjectTools;

function planner(state: { root: string | null; kind: string | null; tools?: ProjectTools; python?: string }) {
  return createPreloadPlanner({
    root: () => state.root,
    kind: () => state.kind,
    tools: () => state.tools ?? tools(),
    configuredPython: () => state.python ?? '',
  });
}

describe('createPreloadPlanner', () => {
  it('прогрев один на проект: второй вызов на то же — false', () => {
    const p = planner({ root: '/p', kind: 'node' });
    expect(p.shouldPreload()).toBe(true);
    expect(p.shouldPreload()).toBe(false);
  });

  it('смена проекта греет заново', () => {
    const state = { root: '/p', kind: 'node' };
    const p = planner(state);
    p.shouldPreload();
    state.root = '/q';
    expect(p.shouldPreload()).toBe(true);
  });

  it('та же папка, но вид проекта распознан позже — греем заново', () => {
    const state: { root: string | null; kind: string | null } = { root: '/p', kind: null };
    const p = planner(state);
    p.shouldPreload();
    state.kind = 'node';
    expect(p.shouldPreload()).toBe(true);
  });

  it('нечего греть — false, и впустую не запоминается', () => {
    const state = { root: null as string | null, kind: null as string | null };
    const p = planner(state);
    expect(p.shouldPreload()).toBe(false);
    state.root = '/p';
    state.kind = 'node';
    expect(p.shouldPreload()).toBe(true);
  });

  it('греем то, что откроется: node → node, python → python', () => {
    expect(planner({ root: '/p', kind: 'node' }).target()).toBe('node');
    expect(planner({ root: '/p', kind: 'python' }).target()).toBe('python');
  });

  it('вид не распознан — греем Python', () => {
    expect(planner({ root: '/p', kind: null }).target()).toBe('python');
  });
});
