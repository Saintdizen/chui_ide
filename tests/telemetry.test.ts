import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_TELEMETRY_FILE_BYTES, TelemetryStore } from '../src/main/ai/telemetry';
import type { ChatRunLog } from '../src/shared/run-log';
import {
  MAX_TELEMETRY_FIELD,
  MAX_TELEMETRY_RECORD,
  buildRunRecord,
  describeRecord,
  formatTelemetryLine,
  parseTelemetry,
  redactSecrets,
} from '../src/shared/telemetry';

/**
 * Журнал прогонов: что в него попадает и чего в нём быть не должно.
 *
 * Главная проверка — вычистка секретов. Ошибка здесь не видна по интерфейсу: файл
 * пишется молча и лежит неделями, поэтому ключ, проехавший в запись, утекает без
 * единого сигнала. Вторая — потолки: одна строка журнала не должна весить больше
 * сотни килобайт, иначе её не прочитать ни редактором, ни глазами.
 */

/** Каталоги, которые уберём после теста: журнал пишется на диск. */
const dirs: string[] = [];

/** Прогон с одним шагом и одним вызовом: в каждом тесте меняем только нужное. */
const run: ChatRunLog = {
  startedAt: 1_000,
  ms: 1_200,
  steps: [
    {
      index: 1,
      ms: 900,
      text: 'Сейчас посмотрю файлы.',
      calls: [
        {
          id: 'c1',
          name: 'read_file',
          args: '{"path":"/p/a.txt"}',
          ok: true,
          summary: 'прочитан a.txt',
          detail: 'строка 1',
          ms: 12,
        },
      ],
    },
  ],
  system: {
    instructions: 'Отвечай кратко.',
    context: 'Карта проекта: 3 файла.',
    provider: 'openai',
    model: 'gpt-4o-mini',
    mode: 'agent',
    permission: 'ask',
    tools: 51,
  },
  trace: { steps: 1, toolCalls: 1, usage: { promptTokens: 900, completionTokens: 120 }, toolsTokens: 4000 },
  finished: 'answer',
};

describe('вычистка секретов', () => {
  it('скрывает ключи с узнаваемым префиксом', () => {
    const text = [
      'OPENAI_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789',
      'github: ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'slack: xoxb-1234567890-abcdefghij',
      'google: AIzaSyA1234567890abcdefghijklmnopqrstuv',
      'aws: AKIAIOSFODNN7EXAMPLE',
    ].join('\n');
    const clean = redactSecrets(text);

    for (const fragment of [
      'abcdefghijklmnopqrstuvwxyz0123456789',
      '1234567890-abcdefghij',
      'IOSFODNN7EXAMPLE',
      'AIzaSyA1234567890',
    ]) {
      expect(clean, fragment).not.toContain(fragment);
    }
    // Метка на месте: видно, что ключ БЫЛ, но не какой.
    expect(clean).toContain('[скрыто]');
  });
});

describe('вычистка: имена полей и JSON', () => {
  it('скрывает имя-значение: api_key, token, password, secret', () => {
    const clean = redactSecrets(
      [
        'api_key = "super-secret-value"',
        'API-KEY: another-secret-value',
        'access_token=ya29a0AfH6SMBvaleur',
        'password=Qwerty12345',
        'DB_SECRET: kf83jf83jf',
      ].join('\n'),
    );

    for (const secret of ['super-secret-value', 'another-secret-value', 'Qwerty12345', 'kf83jf83jf']) {
      expect(clean, secret).not.toContain(secret);
    }
    // Имя поля остаётся: по нему видно, о чём была строка.
    expect(clean).toContain('api_key');
  });

  it('скрывает JSON-поля с ключами и заголовок авторизации', () => {
    const clean = redactSecrets('{"token": "abc123def456", "model": "gpt-4o"}\nAuthorization: Bearer abcdef1234567890');
    expect(clean).not.toContain('abc123def456');
    expect(clean).not.toContain('abcdef1234567890');
    // Не секретное остаётся на месте: журнал нужен именно ради него.
    expect(clean).toContain('gpt-4o');
  });

  it('скрывает пароль в адресе и приватный ключ целиком', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----';
    const clean = redactSecrets(`postgres://user:pa55w0rd@db.local/app\n${key}`);

    expect(clean).not.toContain('pa55w0rd');
    expect(clean).not.toContain('MIIEow');
    expect(clean).toContain('postgres://user:');
  });

  it('обычный текст не меняется', () => {
    for (const text of [
      'Прочитал файл src/main/index.ts, нашёл 3 ошибки.',
      'Токен обновлён: см. настройки провайдера.',
      '',
    ]) {
      expect(redactSecrets(text), text).toBe(text);
    }
  });
});

describe('запись прогона', () => {
  it('берёт итог, модель и шаги из трассы', () => {
    const record = buildRunRecord(run, { conversation: 'chat-1', project: '/p', at: 5_000 });

    expect(record.version).toBe(1);
    expect(record.at).toBe(5_000);
    expect(record.conversation).toBe('chat-1');
    expect(record.project).toBe('/p');
    expect(record.provider).toBe('openai');
    expect(record.model).toBe('gpt-4o-mini');
    expect(record.mode).toBe('agent');
    expect(record.finished).toBe('answer');
    expect(record.ms).toBe(1_200);
    expect(record.steps).toHaveLength(1);
    expect(record.steps[0]!.calls[0]!.name).toBe('read_file');
    expect(record.trace.toolCalls).toBe(1);
  });

  it('секрет из инструкций и ответа модели в запись не попадает', () => {
    const dirty: ChatRunLog = {
      ...run,
      system: { ...run.system, instructions: 'Ключ: OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789' },
      steps: [{ ...run.steps[0]!, text: 'Вижу в конфиге password=Qwerty12345, использую его.' }],
    };
    const line = formatTelemetryLine(buildRunRecord(dirty));

    expect(line).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(line).not.toContain('Qwerty12345');
    // Остальное содержание на месте — иначе журнал бесполезен.
    expect(line).toContain('Вижу в конфиге');
  });
});

describe('потолки записи', () => {
  it('длинные поля обрезаются без разрезания символа', () => {
    const long = 'я'.repeat(MAX_TELEMETRY_FIELD + 500);
    const record = buildRunRecord({ ...run, steps: [{ ...run.steps[0]!, text: long }] });
    const text = record.steps[0]!.text ?? '';

    expect(Array.from(text)).toHaveLength(MAX_TELEMETRY_FIELD + 1);
    expect(text.endsWith('…')).toBe(true);
  });

  it('тяжёлая запись укладывается в потолок: первыми уходят подробности', () => {
    const big = 'я'.repeat(9_000);
    const heavy: ChatRunLog = {
      ...run,
      steps: Array.from({ length: 20 }, (_, index) => ({
        index: index + 1,
        ms: 10,
        text: big,
        reasoning: big,
        calls: [{ id: `c${index}`, name: 'read_file', args: big, ok: true, summary: big, detail: big }],
      })),
      schemas: { read_file: big },
    };
    const record = buildRunRecord(heavy);

    expect(JSON.stringify(record).length).toBeLessThanOrEqual(MAX_TELEMETRY_RECORD);
    expect(record.clipped).toBe(true);
  });
});

describe('файл журнала', () => {
  it('строка одна и без переводов строк внутри', () => {
    const line = formatTelemetryLine(buildRunRecord(run));
    expect(line.split('\n')).toHaveLength(1);
    // Строка разбирается обратно в тот же итог: файл — это JSON Lines.
    expect(JSON.parse(line).finished).toBe('answer');
  });

  it('битая строка не мешает разобрать остальные', () => {
    const good = formatTelemetryLine(buildRunRecord(run));
    const records = parseTelemetry(`${good}\n{"началось но не кончилось\n  \n${good}`);

    expect(records).toHaveLength(2);
    expect(records[0]!.provider).toBe('openai');
  });

  it('строка без времени — не запись', () => {
    expect(parseTelemetry('{"finished":"answer"}')).toEqual([]);
  });

  it('подпись строки называет режим, модель, шаги и итог', () => {
    const text = describeRecord(buildRunRecord(run, { at: 5_000 }));
    expect(text).toContain('agent');
    expect(text).toContain('openai/gpt-4o-mini');
    expect(text).toContain('1 ш.');
    expect(text).toContain('ответ');
  });
});

describe('хранилище журнала', () => {
  /** Свой каталог на тест: журнал пишется на диск, а не в общую папку. */
  async function tempDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-telemetry-'));
    dirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('выключенный журнал не создаёт ни файла, ни папки', async () => {
    const dir = await tempDir();
    const store = new TelemetryStore({ dir: () => path.join(dir, 'telemetry'), enabled: () => false });

    await store.record(run, { conversation: 'chat-1' });

    await expect(fs.readdir(path.join(dir, 'telemetry'))).rejects.toThrow();
    expect(store.enabled).toBe(false);
  });

  it('включённый пишет строку, и её видно в tail', async () => {
    const dir = await tempDir();
    const store = new TelemetryStore({ dir: () => path.join(dir, 'telemetry'), enabled: () => true });

    await store.record(run, { conversation: 'chat-1', project: '/p', at: 5_000 });
    await store.record({ ...run, finished: 'aborted' }, { conversation: 'chat-1', at: 6_000 });

    const tail = await store.tail();
    expect(tail.records).toHaveLength(2);
    expect(tail.records[0]!.finished).toBe('answer');
    expect(tail.records[0]!.conversation).toBe('chat-1');
    expect(tail.records[1]!.finished).toBe('aborted');
    expect(tail.bytes).toBeGreaterThan(0);
    expect(tail.path.endsWith('runs.jsonl')).toBe(true);
  });
});

describe('хранилище: порядок и сдвиг', () => {
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('две записи разом не перемешивают строки', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-telemetry-'));
    dirs.push(dir);
    const store = new TelemetryStore({ dir: () => path.join(dir, 'telemetry'), enabled: () => true });

    await Promise.all([
      store.record(run, { at: 1_000 }),
      store.record({ ...run, system: { ...run.system, model: 'второй' } }, { at: 2_000 }),
      store.record({ ...run, system: { ...run.system, model: 'третий' } }, { at: 3_000 }),
    ]);

    const tail = await store.tail();
    // Каждая строка — самостоятельный JSON: три записи, три разобранные строки.
    expect(tail.records).toHaveLength(3);
    expect(tail.records.map((item) => item.model)).toEqual(['gpt-4o-mini', 'второй', 'третий']);
  });
});

describe('хранилище: сдвиг и очистка', () => {
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('переросший файл сдвигается в предыдущую копию', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-telemetry-'));
    dirs.push(dir);
    const store = new TelemetryStore({ dir: () => path.join(dir, 'telemetry'), enabled: () => true });
    await fs.mkdir(path.join(dir, 'telemetry'), { recursive: true });
    await fs.writeFile(store.path(), 'x'.repeat(MAX_TELEMETRY_FILE_BYTES + 10), 'utf8');

    await store.record(run, { at: 5_000 });

    const previous = store.path().replace(/\.jsonl$/, '.1.jsonl');
    expect((await fs.readFile(previous, 'utf8')).length).toBe(MAX_TELEMETRY_FILE_BYTES + 10);
    // А новый файл начался заново — с одной записи.
    expect((await store.tail()).records).toHaveLength(1);
  });

  it('очистка убирает и журнал, и предыдущую копию', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-telemetry-'));
    dirs.push(dir);
    const store = new TelemetryStore({ dir: () => path.join(dir, 'telemetry'), enabled: () => true });
    await store.record(run, { at: 5_000 });
    await fs.writeFile(store.path().replace(/\.jsonl$/, '.1.jsonl'), 'старое\n', 'utf8');

    await store.clear();

    const tail = await store.tail();
    expect(tail.records).toEqual([]);
    expect(tail.bytes).toBe(0);
  });
});
