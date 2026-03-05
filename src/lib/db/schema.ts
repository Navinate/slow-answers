import { pgTable, uuid, text, timestamp, integer, pgEnum } from 'drizzle-orm/pg-core';

export const questionDepthEnum = pgEnum('question_depth', ['quick', 'deep']);
export const questionStatusEnum = pgEnum('question_status', ['pending', 'batched', 'processing', 'complete', 'failed']);
export const batchStatusEnum = pgEnum('batch_status', ['submitted', 'ended', 'failed']);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  googleId: text('google_id').notNull().unique(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow()
});

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at').notNull()
});

export const batches = pgTable('batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  providerBatchId: text('provider_batch_id'),
  status: batchStatusEnum('status').notNull().default('submitted'),
  questionCount: integer('question_count').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  completedAt: timestamp('completed_at')
});

export const questions = pgTable('questions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  depth: questionDepthEnum('depth').notNull().default('quick'),
  status: questionStatusEnum('status').notNull().default('pending'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  completedAt: timestamp('completed_at'),
  batchId: uuid('batch_id').references(() => batches.id, { onDelete: 'set null' })
});

export const answers = pgTable('answers', {
  id: uuid('id').primaryKey().defaultRandom(),
  questionId: uuid('question_id').notNull().references(() => questions.id, { onDelete: 'cascade' }).unique(),
  content: text('content').notNull(),
  modelUsed: text('model_used').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow()
});

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Question = typeof questions.$inferSelect;
export type Answer = typeof answers.$inferSelect;
export type Batch = typeof batches.$inferSelect;
