import type { APIRoute } from 'astro';
import { google, findOrCreateUser, createSession, setSessionCookie } from '../../../lib/auth';
import { decodeIdToken, type OAuth2Tokens } from 'arctic';

interface GoogleIdTokenClaims {
  sub: string;
  email: string;
  name: string;
}

export const GET: APIRoute = async ({ url, cookies }) => {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const storedState = cookies.get('google_oauth_state')?.value;
  const codeVerifier = cookies.get('google_code_verifier')?.value;

  if (!code || !state || !storedState || state !== storedState || !codeVerifier) {
    return new Response('Invalid OAuth state', { status: 400 });
  }

  let tokens: OAuth2Tokens;
  try {
    tokens = await google.validateAuthorizationCode(code, codeVerifier);
  } catch {
    return new Response('Failed to validate authorization code', { status: 400 });
  }

  const claims = decodeIdToken(tokens.idToken()) as GoogleIdTokenClaims;
  const { sub: googleId, email, name } = claims;

  const user = await findOrCreateUser(googleId, email, name);
  const session = await createSession(user.id);

  // Clear OAuth cookies
  cookies.delete('google_oauth_state', { path: '/' });
  cookies.delete('google_code_verifier', { path: '/' });

  // Set session cookie
  const headers = new Headers();
  setSessionCookie(headers, session.id);
  headers.set('Location', '/ask');

  return new Response(null, {
    status: 302,
    headers
  });
};
