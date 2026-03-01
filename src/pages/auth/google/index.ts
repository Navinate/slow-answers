import type { APIRoute } from 'astro';
import { google } from '../../../lib/auth';
import { generateState, generateCodeVerifier } from 'arctic';

export const GET: APIRoute = async ({ cookies, redirect }) => {
  const state = generateState();
  const codeVerifier = generateCodeVerifier();

  const url = google.createAuthorizationURL(state, codeVerifier, ['openid', 'email', 'profile']);

  cookies.set('google_oauth_state', state, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 10 // 10 minutes
  });

  cookies.set('google_code_verifier', codeVerifier, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 10 // 10 minutes
  });

  return redirect(url.toString());
};
