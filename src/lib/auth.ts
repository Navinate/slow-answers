import { Google } from 'arctic';
import { db } from './db';
import { users, sessions, type User, type Session } from './db/schema';
import { eq } from 'drizzle-orm';

export const google = new Google(
  import.meta.env.GOOGLE_CLIENT_ID ?? process.env.GOOGLE_CLIENT_ID!,
  import.meta.env.GOOGLE_CLIENT_SECRET ?? process.env.GOOGLE_CLIENT_SECRET!,
  import.meta.env.GOOGLE_REDIRECT_URI ?? process.env.GOOGLE_REDIRECT_URI!
);

export function generateSessionId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export async function createSession(userId: string): Promise<Session> {
  const sessionId = generateSessionId();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

  const [session] = await db.insert(sessions).values({
    id: sessionId,
    userId,
    expiresAt
  }).returning();

  return session;
}

export async function validateSession(sessionId: string): Promise<{ user: User; session: Session } | null> {
  const result = await db
    .select({ user: users, session: sessions })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.id, sessionId))
    .limit(1);

  if (result.length === 0) {
    return null;
  }

  const { user, session } = result[0];

  if (session.expiresAt < new Date()) {
    await db.delete(sessions).where(eq(sessions.id, sessionId));
    return null;
  }

  return { user, session };
}

export async function invalidateSession(sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

export async function findOrCreateUser(googleId: string, email: string, name: string): Promise<User> {
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.googleId, googleId))
    .limit(1);

  if (existing.length > 0) {
    return existing[0];
  }

  const [user] = await db.insert(users).values({
    googleId,
    email,
    name
  }).returning();

  return user;
}

export function setSessionCookie(headers: Headers, sessionId: string): void {
  const maxAge = 30 * 24 * 60 * 60; // 30 days in seconds
  headers.set(
    'Set-Cookie',
    `session=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`
  );
}

export function clearSessionCookie(headers: Headers): void {
  headers.set('Set-Cookie', 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}

export function getSessionIdFromCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/session=([^;]+)/);
  return match ? match[1] : null;
}
