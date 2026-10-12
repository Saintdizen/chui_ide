import type { GitIdentity, GitSignFormat, GitSshKey } from '../../shared/git-identity';
import { identityProblems, isValidEmail, signingLabel, sshKeyLabel } from '../../shared/git-identity';
import type { GitModel } from '../core/git-model';
import { clear, h, svgIcon } from './dom';
import { createSelect } from './select';

export interface IdentityModalDeps {
  git: GitModel;
  notify(message: string, kind?: 'info' | 'error'): void;
}

export interface IdentityModalView {
  element: HTMLElement;
  open(): Promise<void>;
  close(): void;
}

/** Пустая личность — то, с чего начинаем до загрузки настроек. */
const BLANK: GitIdentity = {
  name: '',
  email: '',
  signingKey: '',
  format: 'openpgp',
  signCommits: false,
  signTags: false,
  credentialHelper: '',
  keyFound: false,
};

/**
 * Экран «Личность и подпись»: кто автор коммитов, чем они подписаны и какие ключи есть.
 *
 * Всё здесь — настройки самого git (`user.name`, `user.email`, `commit.gpgsign`,
 * `user.signingkey`, `credential.helper`). IDE их показывает, объясняет, что не так,
 * и пишет правки в ЛОКАЛЬНЫЙ конфиг репозитория: личность у человека общая, и молча
 * переписывать его глобальные настройки нельзя.
 *
 * Подпись бывает двух родов — GPG (`openpgp`) и SSH-ключом; у них разный смысл
 * `user.signingkey`, и подсказка в окне меняется вместе с форматом. Ключа, которого
 * нет на машине, видно сразу: иначе отказ случился бы на коммите.
 */
export function createIdentityModal(deps: IdentityModalDeps): IdentityModalView {
  let identity: GitIdentity = BLANK;
  let keys: GitSshKey[] = [];
  let busy = false;

  const nameInput = h('input', { class: 'field-input', type: 'text', spellcheck: false, placeholder: 'Имя автора' });
  const emailInput = h('input', {
    class: 'field-input',
    type: 'text',
    spellcheck: false,
    placeholder: 'mail@example.com',
  });
  const keyInput = h('input', { class: 'field-input', type: 'text', spellcheck: false, placeholder: 'отпечаток GPG' });
  const helperInput = h('input', {
    class: 'field-input',
    type: 'text',
    spellcheck: false,
    placeholder: 'store · cache · libsecret · manager',
  });
  const formatSelect = createSelect({ title: 'Формат подписи' });
  formatSelect.setOptions([
    { value: 'openpgp', label: 'GPG (openpgp)' },
    { value: 'ssh', label: 'SSH-ключ (ssh)' },
  ]);
  const signCommits = h('input', { type: 'checkbox' });
  const signTags = h('input', { type: 'checkbox' });

  const status = h('div', { class: 'identity-status' });
  const problemsBox = h('div', { class: 'identity-problems' });
  const keysList = h('div', { class: 'identity-keys' });

  const close = (): void => {
    element.hidden = true;
  };
  const closeButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Закрыть (Esc)', onClick: close },
    svgIcon('close', 15),
  );

  const saveButton = h('button', { class: 'btn btn-primary', type: 'button', onClick: () => void save() }, 'Сохранить');

  const element = h(
    'div',
    { class: 'modal-backdrop', hidden: true },
    h(
      'div',
      { class: 'modal identity-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Личность и подпись' },
      h(
        'header',
        { class: 'modal-header' },
        h('span', { class: 'modal-title' }, 'Личность и подпись коммитов'),
        closeButton,
      ),
      h(
        'div',
        { class: 'modal-body' },
        status,
        problemsBox,
        h('div', { class: 'settings-divider' }),
        h('div', { class: 'field-label' }, 'Автор коммитов'),
        h('div', { class: 'field-row' }, h('span', { class: 'field-name' }, 'Имя'), nameInput),
        h('div', { class: 'field-row' }, h('span', { class: 'field-name' }, 'Почта'), emailInput),
        h(
          'div',
          { class: 'field-hint' },
          'Эти значения попадают в каждый коммит. Пишутся в конфиг ЭТОГО репозитория ' +
            '(`user.name`, `user.email`); глобальные настройки не трогаются.',
        ),

        h('div', { class: 'settings-divider' }),
        h('div', { class: 'field-label' }, 'Подпись'),
        h('label', { class: 'identity-check' }, signCommits, 'Подписывать коммиты (commit.gpgsign)'),
        h('label', { class: 'identity-check' }, signTags, 'Подписывать теги (tag.gpgsign)'),
        h('div', { class: 'field-row' }, h('span', { class: 'field-name' }, 'Формат'), formatSelect.element),
        h('div', { class: 'field-row' }, h('span', { class: 'field-name' }, 'Ключ'), keyInput),
        h(
          'div',
          { class: 'field-hint' },
          'Для GPG — отпечаток ключа или его почта; для ssh — путь к файлу ключа ' +
            '(например, ~/.ssh/id_ed25519). Подпись проверяют при слиянии и в интерфейсе платформы.',
        ),

        h('div', { class: 'settings-divider' }),
        h('div', { class: 'field-label' }, 'Пароли HTTP'),
        h('div', { class: 'field-row' }, h('span', { class: 'field-name' }, 'Хранилище'), helperInput),
        h(
          'div',
          { class: 'field-hint' },
          'credential.helper — где git хранит логин и токен для https. `store` пишет их в файл ' +
            'открытым текстом, `cache` держит в памяти, `libsecret`/`manager` спрашивают систему. ' +
            'Пусто — git спросит при каждой операции.',
        ),

        h('div', { class: 'settings-divider' }),
        h('div', { class: 'field-label' }, 'Ключи SSH'),
        h(
          'div',
          { class: 'field-hint' },
          'Открытые ключи из ~/.ssh. Публичную часть добавляют в свой аккаунт на GitHub/GitLab — ' +
            'ею же git подписывает коммиты в формате ssh.',
        ),
        keysList,
        h('div', { class: 'modal-actions' }, saveButton),
      ),
    ),
  );

  document.addEventListener('keydown', (event) => {
    if (!element.hidden && event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });
  element.addEventListener('pointerdown', (event) => {
    if (event.target === element) close();
  });

  /** То, что сейчас в полях: по нему показываем предупреждения до сохранения. */
  const preview = (): GitIdentity => ({
    ...identity,
    name: nameInput.value,
    email: emailInput.value,
    signingKey: keyInput.value,
    format: (formatSelect.value === 'ssh' ? 'ssh' : 'openpgp') as GitSignFormat,
    signCommits: signCommits.checked,
    signTags: signTags.checked,
    credentialHelper: helperInput.value,
  });

  const renderProblems = (): void => {
    const draft = preview();
    clear(problemsBox);
    for (const text of identityProblems(draft)) problemsBox.append(h('p', { class: 'identity-problem' }, text));
  };

  formatSelect.onChange((value) => {
    keyInput.placeholder = value === 'ssh' ? '~/.ssh/id_ed25519' : 'отпечаток GPG';
    renderProblems();
  });
  for (const input of [nameInput, emailInput, keyInput, helperInput]) input.addEventListener('input', renderProblems);
  for (const box of [signCommits, signTags]) box.addEventListener('change', renderProblems);

  const renderStatus = (): void => {
    clear(status);
    status.append(h('p', { class: 'identity-line' }, signingLabel(identity)));
  };

  const renderKeys = (): void => {
    clear(keysList);
    if (keys.length === 0) {
      keysList.append(h('p', { class: 'identity-empty' }, 'Ключей в ~/.ssh не найдено.'));
      return;
    }
    for (const key of keys) {
      const copy = h('button', { class: 'btn btn-small', type: 'button' }, 'Скопировать публичный');
      copy.addEventListener('click', () => {
        void navigator.clipboard.writeText(key.publicKey).then(
          () => deps.notify('Публичный ключ скопирован — добавьте его в аккаунт на платформе'),
          () => deps.notify('Не удалось скопировать ключ', 'error'),
        );
      });
      const useForSigning = h('button', { class: 'btn btn-small', type: 'button' }, 'Подписывать этим');
      useForSigning.addEventListener('click', () => {
        formatSelect.setValue('ssh');
        keyInput.value = key.path;
        keyInput.placeholder = '~/.ssh/id_ed25519';
        renderProblems();
      });
      keysList.append(
        h(
          'div',
          { class: 'identity-key' },
          h(
            'div',
            { class: 'identity-key-info' },
            h('span', { class: 'identity-key-name' }, sshKeyLabel(key)),
            key.fingerprint ? h('code', { class: 'identity-key-fp' }, key.fingerprint) : null,
          ),
          h('div', { class: 'identity-key-actions' }, copy, useForSigning),
        ),
      );
    }
  };

  const render = (): void => {
    nameInput.value = identity.name;
    emailInput.value = identity.email;
    keyInput.value = identity.signingKey;
    keyInput.placeholder = identity.format === 'ssh' ? '~/.ssh/id_ed25519' : 'отпечаток GPG';
    formatSelect.setValue(identity.format);
    signCommits.checked = identity.signCommits;
    signTags.checked = identity.signTags;
    helperInput.value = identity.credentialHelper;
    renderStatus();
    renderProblems();
    renderKeys();
  };

  async function save(): Promise<void> {
    if (busy) return;
    const email = emailInput.value.trim();
    if (email !== '' && !isValidEmail(email)) {
      deps.notify('Почта выглядит неверной — проверьте адрес', 'error');
      return;
    }
    busy = true;
    try {
      identity = await deps.git.setIdentity({
        name: nameInput.value,
        email,
        signingKey: keyInput.value,
        format: formatSelect.value === 'ssh' ? 'ssh' : 'openpgp',
        signCommits: signCommits.checked,
        signTags: signTags.checked,
        credentialHelper: helperInput.value,
      });
      deps.notify('Настройки автора и подписи сохранены в конфиге репозитория');
      render();
    } catch (error) {
      deps.notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      busy = false;
    }
  }

  async function open(): Promise<void> {
    element.hidden = false;
    status.replaceChildren(h('p', { class: 'field-hint' }, 'Читаю настройки git…'));
    problemsBox.replaceChildren();
    keysList.replaceChildren();
    try {
      [identity, keys] = await Promise.all([deps.git.identity(), deps.git.sshKeys()]);
    } catch (error) {
      identity = BLANK;
      keys = [];
      deps.notify(error instanceof Error ? error.message : String(error), 'error');
    }
    render();
  }

  return { element, open, close };
}
