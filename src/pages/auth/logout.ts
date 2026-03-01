import type { APIRoute } from 'astro';
import { invalidateSession, clearSessionCookie, getSessionIdFromCookie } from '../../lib/auth';

export const POST: APIRoute = async ({ request }) => {
  const sessionId = getSessionIdFromCookie(request.headers.get('cookie'));

  if (sessionId) {
    await invalidateSession(sessionId);
  }

  const headers = new Headers();
  clearSessionCookie(headers);
  headers.set('Location', '/');

  return new Response(null, {
    status: 302,
    headers
  });
};
