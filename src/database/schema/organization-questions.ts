import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations.ts';
import { users } from './users.ts';

/**
 * Custom onboarding questions created by partner organizations (Part 4).
 * Types supported: 'text' | 'single_choice' | 'multiple_choice' | 'number' | 'yes_no'.
 */
export const organizationOnboardingQuestions = pgTable(
  'organization_onboarding_questions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    organizationId: bigint('organization_id', { mode: 'number' })
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    prompt: text('prompt').notNull(),
    description: text('description'),
    type: text('type').notNull(), // 'text' | 'single_choice' | 'multiple_choice' | 'number' | 'yes_no'
    options: jsonb('options').$type<string[]>(),
    required: boolean('required').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    version: integer('version').notNull().default(1),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('org_questions_org_idx').on(t.organizationId, t.active, t.sortOrder),
  ],
);

/**
 * Answers to custom onboarding questions, stored per user and per organization.
 * Includes a snapshot of the prompt and type at the time of answering for version stability.
 */
export const organizationOnboardingAnswers = pgTable(
  'organization_onboarding_answers',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    organizationId: bigint('organization_id', { mode: 'number' })
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    questionId: bigint('question_id', { mode: 'number' })
      .notNull()
      .references(() => organizationOnboardingQuestions.id, { onDelete: 'cascade' }),
    questionPrompt: text('question_prompt').notNull(),
    questionType: text('question_type').notNull(),
    questionVersion: integer('question_version').notNull().default(1),
    answer: jsonb('answer').$type<unknown>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('org_user_question_unq').on(t.organizationId, t.userId, t.questionId),
    index('org_answers_user_idx').on(t.userId, t.organizationId),
  ],
);
