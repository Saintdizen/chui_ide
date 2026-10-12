import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Рабочая область из нескольких корней. Проверяем на настоящих каталогах, потому что
 * главное здесь — доступ к файлам: с несколькими корнями `safePath` обязан пропускать
 * путь, лежащий в ЛЮБОМ из них, и по-прежнему отказывать тому, что вне области.
 */
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeDir(name: string): Promise<string> {
  const base = await mkdtemp(path.join(tmpdir(), 'chui-multi-'));
  roots.push(base);
  const dir = path.join(base, name);
  await mkdir(dir, { recursive: true });
  return dir;
}

function service(): WorkspaceService {
  return new WorkspaceService(
    () => undefined,
    () => undefined,
  );
}

describe('WorkspaceService: корни рабочей области', () => {
  it('open заменяет область одним корнем', async () => {
    const one = await makeDir('one');
    const svc = service();
    const info = await svc.open(one);
    expect(info.root).toBe(one);
    expect(info.roots.map((item) => item.root)).toEqual([one]);
  });

  it('addRoot добавляет папку и делает её активной', async () => {
    const one = await makeDir('one');
    const two = await makeDir('two');
    const svc = service();
    await svc.open(one);
    const info = await svc.addRoot(two);
    expect(info.root).toBe(two);
    expect(info.roots.map((item) => item.root)).toEqual([one, two]);
    expect(svc.rootPath()).toBe(two);
  });

  it('removeRoot убирает корень, активным становится оставшийся', async () => {
    const one = await makeDir('one');
    const two = await makeDir('two');
    const svc = service();
    await svc.open(one);
    await svc.addRoot(two);
    const info = await svc.removeRoot(two);
    expect(info?.root).toBe(one);
    expect(info?.roots.map((item) => item.root)).toEqual([one]);
  });

  it('removeRoot последнего корня даёт null', async () => {
    const one = await makeDir('one');
    const svc = service();
    await svc.open(one);
    expect(await svc.removeRoot(one)).toBeNull();
    expect(svc.rootPath()).toBeNull();
  });

  it('setActiveRoot переключает активный корень', async () => {
    const one = await makeDir('one');
    const two = await makeDir('two');
    const svc = service();
    await svc.open(one);
    await svc.addRoot(two);
    await svc.setActiveRoot(one);
    expect(svc.rootPath()).toBe(one);
    await expect(svc.setActiveRoot('/нет/такой')).rejects.toThrow();
  });

  it('файл читается из ЛЮБОГО корня области', async () => {
    const one = await makeDir('one');
    const two = await makeDir('two');
    await writeFile(path.join(two, 'b.txt'), 'из второй папки\n', 'utf8');
    const svc = service();
    await svc.open(one);
    await svc.addRoot(two);
    // Активен второй корень, но файл первого тоже доступен.
    await writeFile(path.join(one, 'a.txt'), 'из первой папки\n', 'utf8');
    expect((await svc.readFile(path.join(one, 'a.txt'))).text).toBe('из первой папки\n');
    expect((await svc.readFile(path.join(two, 'b.txt'))).text).toBe('из второй папки\n');
  });

  it('путь вне всех корней по-прежнему отвергается', async () => {
    const one = await makeDir('one');
    const svc = service();
    await svc.open(one);
    await expect(svc.readFile(path.join(one, '..', 'чужое.txt'))).rejects.toThrow(/вне рабочей/);
  });

  it('removeRoot забывает папку: файл из неё больше не читается', async () => {
    const one = await makeDir('one');
    const two = await makeDir('two');
    await writeFile(path.join(two, 'b.txt'), 'b\n', 'utf8');
    const svc = service();
    await svc.open(one);
    await svc.addRoot(two);
    await svc.removeRoot(two);
    await expect(svc.readFile(path.join(two, 'b.txt'))).rejects.toThrow(/вне рабочей/);
  });
});
