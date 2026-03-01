import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { questions } from '../../../lib/db/schema';
import { eq, desc } from 'drizzle-orm';

export const GET: APIRoute = async ({ locals }) => {
  if (!locals.user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const userQuestions = await db
    .select()
    .from(questions)
    .where(eq(questions.userId, locals.user.id))
    .orderBy(desc(questions.createdAt));

  return new Response(JSON.stringify(userQuestions), {
    headers: { 'Content-Type': 'application/json' }
  });
};

export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const body = await request.json();
  const { content, depth = 'quick' } = body;

  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    return new Response(JSON.stringify({ error: 'Content is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (depth !== 'quick' && depth !== 'deep') {
    return new Response(JSON.stringify({ error: 'Invalid depth' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const [question] = await db.insert(questions).values({
    userId: locals.user.id,
    content: content.trim(),
    depth
  }).returning();

  return new Response(JSON.stringify(question), {
    status: 201,
    headers: { 'Content-Type': 'application/json' }
  });
};
