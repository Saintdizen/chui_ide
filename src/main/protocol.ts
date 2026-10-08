import { net, protocol } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const APP_SCHEME = 'app';
export const APP_ORIGIN = `${APP_SCHEME}://bundle`;

/**
 * В продакшене renderer отдаётся не через file://, а через собственный протокол.
 *
 * Причина простая: у схемы file:// «непрозрачный» origin, и Chromium запрещает
 * создавать из такой страницы web worker'ы. Monaco работает именно на worker'ах,
 * так что с file:// подсветка и TS-сервисы молча не заведутся.
 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
  ]);
}

export function serveRenderer(): void {
  const rendererDir = path.join(__dirname, '../renderer');

  protocol.handle(APP_SCHEME, async (request) => {
    let relative: string;
    try {
      relative = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response('Bad request', { status: 400 });
    }

    const target = path.join(rendererDir, relative === '/' || relative === '' ? 'index.html' : relative);
    if (target !== rendererDir && !target.startsWith(rendererDir + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      return await net.fetch(pathToFileURL(target).toString());
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}
