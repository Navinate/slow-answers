import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { questions, answers } from '../../../lib/db/schema';
import { eq, and } from 'drizzle-orm';

export const GET: APIRoute = async ({ locals, params }) => {
  if (!locals.user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const questionId = params.id;
  if (!questionId) {
    return new Response(JSON.stringify({ error: 'Question ID required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const result = await db
    .select({
      question: questions,
      answer: answers
    })
    .from(questions)
    .leftJoin(answers, eq(questions.id, answers.questionId))
    .where(and(
      eq(questions.id, questionId),
      eq(questions.userId, locals.user.id)
    ))
    .limit(1);

  if (result.length === 0) {
    return new Response(JSON.stringify({ error: 'Question not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const { question, answer } = result[0];

  return new Response(JSON.stringify({ ...question, answer }), {
    headers: { 'Content-Type': 'application/json' }
  });
};
