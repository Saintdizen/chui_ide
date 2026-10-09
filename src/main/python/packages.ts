import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Какие модули видит интерпретатор проекта: что импортировать, а что нет.
 *
 * Живёт в main: здесь и процесс интерпретатора, и файловая система. Renderer
 * получает уже готовый ответ — какие имена недоступны, — и рисует пометки.
 *
 * Список доступного снимаем с самого интерпретатора, а не угадываем по каталогам:
 * только он знает и стандартную библиотеку, и что поставлено в его окружение.
 * Спрашиваем его заново на каждую проверку: человек ставит пакеты, пока IDE
 * открыта, и заметить это иначе неоткуда. Открытые разом файлы делят один процесс.
 */

/* ── доступные модули ───────────────────────────────────────────────────── */

/**
 * Скрипт на Python: печатает JSON-массив имён модулей верхнего уровня, которые
 * можно импортировать. Здесь нет импорта самих модулей — только имена: запускать
 * чужой код ради проверки было бы и медленно, и небезопасно.
 */
const AVAILABLE_SCRIPT = `import json, os, sys

def base(item):
    for suffix in ('.pyi', '.pyo', '.pyc', '.py'):
        if item.endswith(suffix):
            return item[: -len(suffix)]
    if item.endswith('.pyd') or '.so' in item:
        return item.split('.')[0]
    return None

names = set(sys.builtin_module_names)
names.update(getattr(sys, 'stdlib_module_names', ()))

# Python 3.9 и старше не знает stdlib_module_names: собираем имена по каталогу.
if not getattr(sys, 'stdlib_module_names', None):
    try:
        import sysconfig
        stdlib = sysconfig.get_paths().get('stdlib') or ''
    except Exception:
        stdlib = ''
    for folder in (stdlib, os.path.join(stdlib, 'lib-dynload')):
        try:
            items = os.listdir(folder)
        except OSError:
            continue
        for item in items:
            name = base(item)
            if name:
                names.add(name)
            elif os.path.isfile(os.path.join(folder, item, '__init__.py')):
                names.add(item)

# Каталоги импорта: то, что интерпретатор видит на самом деле. Среди них первым идёт
# '' — рабочий каталог, то есть корень проекта. Без этого обхода свои модули проекта
# (и пакеты без __init__.py — в Python 3 это namespace-пакеты) казались неустановленными.
for folder in sys.path:
    target = folder or os.getcwd()
    try:
        entries = os.scandir(target)
    except OSError:
        continue
    with entries:
        for entry in entries:
            if entry.name == '__pycache__' or entry.name.startswith('.'):
                continue
            name = base(entry.name)
            if name:
                names.add(name)
            elif entry.is_dir():
                names.add(entry.name)

try:
    import importlib.metadata as metadata
except Exception:
    metadata = None

if metadata is not None:
    for dist in metadata.distributions():
        top = None
        try:
            top = dist.read_text('top_level.txt')
        except Exception:
            top = None
        if top:
            for line in top.split():
                names.add(line)
            continue
        label = ''
        try:
            label = (dist.metadata['Name'] if dist.metadata else '') or ''
        except Exception:
            label = ''
        if label:
            names.add(label.replace('-', '_').replace('.', '_'))

print(json.dumps(sorted(n for n in names if n and n.isidentifier())))
`;

/**
 * Идущие запросы к интерпретатору: один путь — один процесс.
 *
 * Снимок окружения не кэшируем между вызовами: человек ставит пакеты, пока IDE
 * открыта, и узнать об этом нам неоткуда. Зато открытые разом файлы делят один
 * процесс — `importlib.metadata` обходит все распределения, и N раз на N файлов
 * делать это незачем.
 */
const inFlight = new Map<string, Promise<ReadonlySet<string>>>();

/** Модули верхнего уровня, которые видит интерпретатор: стандартная библиотека и поставленное. */
export function availableModules(python: string, cwd?: string): Promise<ReadonlySet<string>> {
  const running = inFlight.get(python);
  if (running) return running;

  const pending = runInterpreter(python, cwd).finally(() => inFlight.delete(python));
  inFlight.set(python, pending);
  return pending;
}

/**
 * Модули, которых нет ни у интерпретатора, ни в проекте.
 *
 * Интерпретатора нет — судить не о чем: лучше не подчёркивать ничего, чем
 * подчеркнуть всё подряд в проекте без Python-окружения.
 */
export async function missingModules(
  root: string | null,
  python: string | null,
  modules: readonly string[],
): Promise<string[]> {
  const unique = [...new Set(modules)].filter((name) => name);
  if (unique.length === 0 || !python) return [];

  const available = new Set<string>();
  try {
    for (const name of await availableModules(python, root ?? undefined)) available.add(name);
  } catch {
    return [];
  }
  if (root) for (const name of await projectModules(root)) available.add(name);

  return unique.filter((name) => !available.has(name));
}

/**
 * Свои модули проекта: `app.py` в корне и папки с `__init__.py` (корень и `src`).
 * Без этого локальный `import app` выглядел бы как неустановленная библиотека.
 */
async function projectModules(root: string): Promise<ReadonlySet<string>> {
  const names = new Set<string>();
  for (const dir of [root, path.join(root, 'src')]) {
    const dirents = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of dirents) {
      if (entry.isFile() && entry.name.endsWith('.py')) {
        names.add(entry.name.slice(0, -3));
        continue;
      }
      if (!entry.isDirectory()) continue;
      const init = await fs
        .access(path.join(dir, entry.name, '__init__.py'))
        .then(() => true)
        .catch(() => false);
      if (init) names.add(entry.name);
    }
  }
  return names;
}

/* ── запуск интерпретатора ──────────────────────────────────────────────── */

function runInterpreter(python: string, cwd?: string): Promise<ReadonlySet<string>> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-c', AVAILABLE_SCRIPT], {
      cwd,
      env: { ...process.env, NO_COLOR: '1', PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
    });

    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8');
    });

    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(err.trim() || `${python} завершился с кодом ${code}`));
        return;
      }
      const line = out.trim().split(/\r?\n/).pop() ?? '[]';
      try {
        resolve(new Set(JSON.parse(line) as string[]));
      } catch {
        reject(new Error('Не удалось разобрать список модулей'));
      }
    });
  });
}
