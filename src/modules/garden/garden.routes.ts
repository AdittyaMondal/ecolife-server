import { requireUser } from '@common/guards/auth.guard.ts';
import { ok } from '@common/interceptors/response-envelope.ts';
import { jsonOk, secured } from '@common/openapi/envelope.ts';
import { createModule } from '@common/openapi/factory.ts';
import { db } from '@database/client.ts';
import { userGardens } from '@database/schema/index.ts';
import { createRoute, z } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';

export const gardenRoutes = createModule();

const getGardenResponseSchema = z.object({
  gardenState: z.record(z.string(), z.unknown()).nullable(),
  updatedAt: z.string().nullable(),
});

const putGardenRequestSchema = z.object({
  gardenState: z.record(z.string(), z.unknown()),
});

const putGardenResponseSchema = z.object({
  success: z.boolean(),
  updatedAt: z.string(),
});

// GET /api/v1/garden — Fetch user's saved garden arrangement
gardenRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['garden'],
    summary: "Get user's saved garden arrangement and layout from DB",
    middleware: [requireUser] as const,
    security: secured,
    responses: {
      200: jsonOk(getGardenResponseSchema, 'User garden state'),
    },
  }),
  async (c) => {
    const user = c.get('user');
    const [row] = await db
      .select()
      .from(userGardens)
      .where(eq(userGardens.userId, user.id))
      .limit(1);

    return ok(
      c,
      {
        gardenState: (row?.gardenState as Record<string, unknown>) ?? null,
        updatedAt: row?.updatedAt ? new Date(row.updatedAt).toISOString() : null,
      },
      200,
    );
  },
);

// PUT /api/v1/garden — Save / sync user's garden arrangement
gardenRoutes.openapi(
  createRoute({
    method: 'put',
    path: '/',
    tags: ['garden'],
    summary: "Save user's garden arrangement and layout to DB",
    middleware: [requireUser] as const,
    security: secured,
    request: {
      body: {
        content: {
          'application/json': {
            schema: putGardenRequestSchema,
          },
        },
      },
    },
    responses: {
      200: jsonOk(putGardenResponseSchema, 'Garden saved successfully'),
    },
  }),
  async (c) => {
    const user = c.get('user');
    const body = c.req.valid('json');
    const now = new Date();

    await db
      .insert(userGardens)
      .values({
        userId: user.id,
        gardenState: body.gardenState,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: userGardens.userId,
        set: {
          gardenState: body.gardenState,
          updatedAt: now,
        },
      });

    return ok(
      c,
      {
        success: true,
        updatedAt: now.toISOString(),
      },
      200,
    );
  },
);
