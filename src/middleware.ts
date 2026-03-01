import { defineMiddleware } from 'astro:middleware';
import { validateSession, getSessionIdFromCookie } from './lib/auth';
import { startProcessor } from './lib/ai';

// Start the background processor once
let processorStarted = false;

export const onRequest = defineMiddleware(async (context, next) => {
  // Start processor on first request (only in production-like environments)
  if (!processorStarted && process.env.DATABASE_URL) {
    processorStarted = true;
    try {
      startProcessor(30000); // Check every 30 seconds
    } catch (error) {
      console.error('[Middleware] Failed to start processor:', error);
    }
  }

  const sessionId = getSessionIdFromCookie(context.request.headers.get('cookie'));

  if (sessionId) {
    const result = await validateSession(sessionId);
    if (result) {
      context.locals.user = result.user;
      context.locals.session = result.session;
    }
  }

  return next();
});
