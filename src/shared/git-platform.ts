/**
 * Платформа хостинга и запросы на слияние (pull/merge request).
 *
 * Репозиторий живёт не сам по себе, а на площадке: GitHub, GitLab, Bitbucket и им
 * подобных. Узнать площадку можно по адресу удалённого репозитория, а с ней приходят
 * и «запросы на слияние» — pull request (PR) на GitHub и merge request (MR) на GitLab:
 * одна и та же вещь под разными именами.
 *
 * Здесь только модель и разбор:
 *   • `parseRemoteUrl` — разобрать адрес (`https://…`, `git@…:…`, `ssh://…`) на
 *     площадку, владельца и репозиторий;
 *   • `platformOf` — какая это площадка по имени хоста;
 *   • адреса веб-страниц: сам запрос и страница создания (`compare` у GitHub,
 *     `-/merge_requests/new` у GitLab);
 *   • разбор ответа консольных клиентов (`gh`, `glab`) в один общий список.
 *
 * Разбор ответов клиентов терпимый: версии печатают чуть по-разному, и понятую
 * строку лучше пропустить, чем уронить список целиком.
 *
 * Модуль чистый: ни процессов, ни сети. Их дело — в main (`git/git.ts`).
 */

/** Известные площадки. `null`-площадки не бывает: незнакомый хост — тоже «other». */
export type ForgePlatform = 'github' | 'gitlab' | 'bitbucket' | 'other';

/** Слитая (или отклонённая) ссылка на репозиторий. */
export interface ForgeRepo {
  platform: ForgePlatform;
  /** Имя хоста: `github.com`, `gitlab.example.com`. */
  host: string;
  /** Владелец или организация (у GitLab — пространство имён, может быть вложенным). */
  owner: string;
  /** Имя репозитория (без `.git`). */
  repo: string;
}

/** Состояние запроса на слияние — общее для площадок. */
export type ForgeRequestState = 'open' | 'closed' | 'merged' | 'draft';

/** Запрос на слияние (PR/MR) в одной записи, независимо от площадки. */
export interface ForgeRequest {
  /** Номер: `#12` на GitHub, `!12` на GitLab — здесь только число. */
  number: number;
  title: string;
  author: string;
  state: ForgeRequestState;
  /** Ветка, из которой предлагают слияние. */
  sourceBranch: string;
  /** Ветка, в которую предлагают влить. */
  targetBranch: string;
  /** Страница запроса в браузере. */
  url: string;
  /** Когда последний раз трогали (текст площадки — приводить к дате не берёмся). */
  updatedAt: string;
  /** Метки/теги запроса. */
  labels: string[];
}

/** Что знает главный процесс о площадке текущего репозитория. */
export interface ForgeInfo {
  /** Связан ли репозиторий с площадкой вообще (есть удалённый репозиторий). */
  repo: ForgeRepo | null;
  /** Имя удалённого репозитория, по которому это понято (`origin`). */
  remote: string;
  /** Консольный клиент площадки: `gh` для GitHub, `glab` для GitLab, `null` — нет. */
  cli: 'gh' | 'glab' | null;
  /** Найден ли клиент в системе. */
  cliAvailable: boolean;
  /** Вошёл ли клиент в аккаунт (`gh auth status`). */
  authenticated: boolean;
  /** Запросы на слияние — если клиент есть и вошёл. */
  requests: ForgeRequest[];
  /** Почему список пуст: нет клиента, не вошёл, ошибка сети. Пусто — всё хорошо. */
  note: string;
}

/** Разбор адреса удалённого репозитория. `null` — понять не удалось. */
export function parseRemoteUrl(url: string): { host: string; owner: string; repo: string } | null {
  const raw = url.trim();
  if (raw === '') return null;

  // ssh-вид: `git@github.com:owner/repo.git`. Двоеточие отделяет хост от пути.
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(raw);
  if (scp && !raw.includes('://') && !/^[a-zA-Z]:\\/.test(raw)) {
    return splitPath(scp[1]!, scp[2]!);
  }

  // Остальные виды: `https://host/owner/repo.git`, `ssh://git@host/owner/repo`.
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(raw);
  if (withScheme) return splitPath(withScheme[1]!, withScheme[2]!);

  return null;
}

/** Хост даёт площадку, путь — владельца и репозиторий (без `.git`). */
function splitPath(host: string, path: string): { host: string; owner: string; repo: string } | null {
  const clean = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  if (clean === '') return null;
  const parts = clean.split('/').filter((part) => part !== '');
  if (parts.length < 2) return null;
  const repo = parts[parts.length - 1]!;
  // У GitLab пространство имён может быть вложенным: `group/subgroup/project`.
  const owner = parts.slice(0, -1).join('/');
  return { host: host.toLowerCase(), owner, repo };
}

/** Площадка по имени хоста. Незнакомый хост — `other`, а не отказ. */
export function platformOf(host: string): ForgePlatform {
  const name = host.toLowerCase();
  if (name === 'github.com' || name.endsWith('.github.com')) return 'github';
  if (name === 'gitlab.com' || name.includes('gitlab')) return 'gitlab';
  if (name === 'bitbucket.org' || name.includes('bitbucket')) return 'bitbucket';
  return 'other';
}

/** Репозиторий целиком: адрес плюс площадка. `null` — адрес не разобран. */
export function forgeRepo(url: string): ForgeRepo | null {
  const parsed = parseRemoteUrl(url);
  if (!parsed) return null;
  return { platform: platformOf(parsed.host), host: parsed.host, owner: parsed.owner, repo: parsed.repo };
}

/** Подпись площадки для интерфейса. */
export function platformLabel(platform: ForgePlatform): string {
  if (platform === 'github') return 'GitHub';
  if (platform === 'gitlab') return 'GitLab';
  if (platform === 'bitbucket') return 'Bitbucket';
  return 'репозиторий';
}

/** Как на площадке называется запрос на слияние. */
export function requestWord(platform: ForgePlatform): string {
  return platform === 'gitlab' ? 'merge request' : 'pull request';
}

/** Консольный клиент площадки: у Bitbucket и незнакомых площадок своего нет. */
export function cliFor(platform: ForgePlatform): 'gh' | 'glab' | null {
  if (platform === 'github') return 'gh';
  if (platform === 'gitlab') return 'glab';
  return null;
}

/** Страница запроса на слияние в браузере. */
export function requestWebUrl(repo: ForgeRepo, number: number): string {
  const base = `https://${repo.host}/${repo.owner}/${repo.repo}`;
  if (repo.platform === 'gitlab') return `${base}/-/merge_requests/${number}`;
  if (repo.platform === 'bitbucket') return `${base}/pull-requests/${number}`;
  return `${base}/pull/${number}`;
}

/**
 * Страница создания запроса: GitHub и Bitbucket умеют сравнивать ветки адресом,
 * у GitLab это отдельная страница новой записи с параметрами.
 */
export function newRequestWebUrl(repo: ForgeRepo, source: string, target: string): string {
  const base = `https://${repo.host}/${repo.owner}/${repo.repo}`;
  const branch = encodeURIComponent(source);
  const into = encodeURIComponent(target);
  if (repo.platform === 'gitlab') {
    return `${base}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${branch}&merge_request%5Btarget_branch%5D=${into}`;
  }
  if (repo.platform === 'bitbucket') return `${base}/pull-requests/new?source=${branch}&dest=${into}`;
  return `${base}/compare/${into}...${branch}?expand=1`;
}

/** Состояние запроса из того, что пишет площадка: слова у всех разные. */
function stateOf(value: unknown): ForgeRequestState {
  const text = String(value ?? '').toLowerCase();
  if (text === 'merged') return 'merged';
  if (text === 'draft' || text === 'drafting') return 'draft';
  if (text === 'closed' || text === 'declined') return 'closed';
  return 'open';
}

/** Метки запроса: бывают строками и объектами со `name`. */
function labelsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) =>
      typeof item === 'string'
        ? item
        : typeof item === 'object' && item !== null && typeof (item as { name?: unknown }).name === 'string'
          ? ((item as { name: string }).name as string)
          : '',
    )
    .filter((name) => name !== '');
}

/**
 * Разбор ответа `gh pr list --json …`. GitHub отдаёт массив объектов, где автор —
 * вложенный объект `author.login`, а ветки — `headRefName`/`baseRefName`.
 */
export function parseGhRequests(json: string): ForgeRequest[] {
  const list = safeArray(json);
  const requests: ForgeRequest[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const value = item as Record<string, unknown>;
    const number = Number(value.number);
    if (!Number.isFinite(number) || number <= 0) continue;
    const draft = value.isDraft === true;
    requests.push({
      number,
      title: typeof value.title === 'string' ? value.title : '',
      author:
        typeof value.author === 'object' &&
        value.author !== null &&
        typeof (value.author as { login?: unknown }).login === 'string'
          ? ((value.author as { login: string }).login as string)
          : '',
      state: draft ? 'draft' : stateOf(value.state),
      sourceBranch: typeof value.headRefName === 'string' ? value.headRefName : '',
      targetBranch: typeof value.baseRefName === 'string' ? value.baseRefName : '',
      url: typeof value.url === 'string' ? value.url : '',
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
      labels: labelsOf(value.labels),
    });
  }
  return requests;
}

/**
 * Разбор ответа `glab mr list --output json`. GitLab пишет ветки как
 * `source_branch`/`target_branch`, автора — как `author.username`, номер — `iid`.
 */
export function parseGlabRequests(json: string): ForgeRequest[] {
  const list = safeArray(json);
  const requests: ForgeRequest[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const value = item as Record<string, unknown>;
    const number = Number(value.iid ?? value.number);
    if (!Number.isFinite(number) || number <= 0) continue;
    const draft = value.draft === true || value.work_in_progress === true;
    requests.push({
      number,
      title: typeof value.title === 'string' ? value.title : '',
      author:
        typeof value.author === 'object' &&
        value.author !== null &&
        typeof (value.author as { username?: unknown }).username === 'string'
          ? ((value.author as { username: string }).username as string)
          : '',
      state: draft ? 'draft' : stateOf(value.state),
      sourceBranch: typeof value.source_branch === 'string' ? value.source_branch : '',
      targetBranch: typeof value.target_branch === 'string' ? value.target_branch : '',
      url: typeof value.web_url === 'string' ? value.web_url : '',
      updatedAt: typeof value.updated_at === 'string' ? value.updated_at : '',
      labels: labelsOf(value.labels),
    });
  }
  return requests;
}

/** Разобрать JSON-массив ответа клиента; мусор даёт пустой список. */
function safeArray(json: string): unknown[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/* ── комментарии к запросу ─────────────────────────────────────────────── */

/** Комментарий (note) к запросу на слияние в одной записи, независимо от площадки. */
export interface ForgeComment {
  /** Автор: логин на GitHub, имя пользователя на GitLab. */
  author: string;
  /** Текст комментария — markdown как есть, без пересказа. */
  body: string;
  /** Когда написан (текст площадки — приводить к дате не берёмся). */
  createdAt: string;
  /** Прямая ссылка на комментарий, если площадка её дала. */
  url: string;
}

/** Автор из вложенного объекта: `author.login` у GitHub, `author.username` у GitLab. */
function commentAuthor(value: unknown): string {
  if (typeof value !== 'object' || value === null) return typeof value === 'string' ? value : '';
  const author = value as { login?: unknown; username?: unknown; name?: unknown };
  if (typeof author.login === 'string') return author.login;
  if (typeof author.username === 'string') return author.username;
  return typeof author.name === 'string' ? author.name : '';
}

/** Текст комментария из поля, как его называет площадка (`body` / `note`). */
function commentBody(value: Record<string, unknown>): string {
  if (typeof value.body === 'string') return value.body;
  return typeof value.note === 'string' ? value.note : '';
}

/**
 * Разбор ответа `gh pr view <n> --json comments`. GitHub отдаёт объект с полем
 * `comments` (автор — `author.login`). Терпимо принимаем и голый массив: версии
 * и соседние команды печатают по-разному, а понятую строку лучше показать.
 */
export function parseGhComments(json: string): ForgeComment[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { comments?: unknown }).comments)
      ? ((parsed as { comments: unknown[] }).comments as unknown[])
      : [];

  const comments: ForgeComment[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const value = item as Record<string, unknown>;
    const body = commentBody(value);
    if (body === '') continue;
    comments.push({
      author: commentAuthor(value.author),
      body,
      createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
      url: typeof value.url === 'string' ? value.url : '',
    });
  }
  return comments;
}

/**
 * Разбор ответа `glab api projects/:id/merge_requests/<n>/notes`. GitLab отдаёт
 * массив заметок: текст в `body`, автор — `author.username`, время — `created_at`.
 * Системные заметки (`system: true`) — это события о смене ветки и меток, а не
 * слова человека, поэтому их не показываем.
 */
export function parseGlabComments(json: string): ForgeComment[] {
  const comments: ForgeComment[] = [];
  for (const item of safeArray(json)) {
    if (typeof item !== 'object' || item === null) continue;
    const value = item as Record<string, unknown>;
    if (value.system === true) continue;
    const body = commentBody(value);
    if (body === '') continue;
    comments.push({
      author: commentAuthor(value.author),
      body,
      createdAt: typeof value.created_at === 'string' ? value.created_at : '',
      url: '',
    });
  }
  return comments;
}

/** Подпись запроса: `#12 · заголовок`, а черновик помечен словом. */
export function requestLabel(request: ForgeRequest): string {
  const mark = request.state === 'draft' ? 'черновик · ' : '';
  return `${mark}#${request.number} ${request.title}`.trim();
}

/** Короткая подпись про ветки: `feat → main`. */
export function branchesLabel(request: ForgeRequest): string {
  return `${request.sourceBranch} → ${request.targetBranch}`;
}

/** Сколько открытых запросов — для заголовка списка. */
export function openRequestCount(requests: readonly ForgeRequest[]): number {
  return requests.filter((request) => request.state === 'open' || request.state === 'draft').length;
}

/** Открыт ли запрос для этой ветки (её уже предлагают влить). */
export function requestForBranch(requests: readonly ForgeRequest[], branch: string): ForgeRequest | null {
  return (
    requests.find(
      (request) => request.sourceBranch === branch && request.state !== 'closed' && request.state !== 'merged',
    ) ?? null
  );
}
