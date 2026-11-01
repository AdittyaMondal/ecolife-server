import { requireUser } from '@common/guards/auth.guard.ts';
import { ok } from '@common/interceptors/response-envelope.ts';
import { errorResponses, jsonOk, secured } from '@common/openapi/envelope.ts';
import { createModule } from '@common/openapi/factory.ts';
import { cursorQuery, idParam, paginated } from '@common/openapi/params.ts';
import { db } from '@database/client.ts';
import { notifications } from '@database/schema/index.ts';
import { createRoute, z } from '@hono/zod-openapi';
import * as refService from '@modules/reference/reference.service.ts';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  registerPushToken,
  sendPredefinedNotification,
  unregisterPushToken,
} from './fcm.service.ts';
import {
  deletePushTokenBodySchema,
  notificationSchema,
  predefinedNotificationBodySchema,
  pushTokenBodySchema,
} from './notifications.schema.ts';

export const notificationRoutes = createModule();

/**
 * POST /api/v1/notifications/push-token
 * Registers an FCM push token for the authenticated user's Android device.
 */
notificationRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/push-token',
    tags: ['notifications'],
    summary: 'Register FCM device push token',
    description: 'Registers or updates the FCM push token for the authenticated user.',
    security: secured,
    middleware: [requireUser] as const,
    request: {
      body: { content: { 'application/json': { schema: pushTokenBodySchema } }, required: true },
    },
    responses: {
      200: jsonOk(z.object({ registered: z.boolean() }), 'Token registered'),
      400: errorResponses[400],
      401: errorResponses[401],
    },
  }),
  async (c) => {
    const user = c.get('user');
    const { token, platform } = c.req.valid('json');
    await registerPushToken(user.id, token, platform);
    return ok(c, { registered: true }, 200);
  },
);

/**
 * DELETE /api/v1/notifications/push-token
 * Unregisters an FCM push token (e.g., when the user logs out).
 */
notificationRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/push-token',
    tags: ['notifications'],
    summary: 'Unregister FCM push token',
    description: 'Removes the device FCM push token on user logout.',
    security: secured,
    middleware: [requireUser] as const,
    request: {
      body: {
        content: { 'application/json': { schema: deletePushTokenBodySchema } },
        required: true,
      },
    },
    responses: {
      200: jsonOk(z.object({ unregistered: z.boolean() }), 'Token unregistered'),
      400: errorResponses[400],
      401: errorResponses[401],
    },
  }),
  async (c) => {
    const user = c.get('user');
    const { token } = c.req.valid('json');
    await unregisterPushToken(user.id, token);
    return ok(c, { unregistered: true }, 200);
  },
);

/**
 * POST /api/v1/notifications/send-predefined
 * Simple endpoint to trigger a predefined FCM notification.
 */
notificationRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/send-predefined',
    tags: ['notifications'],
    summary: 'Send a predefined notification',
    description:
      'Dispatches one of the predefined notifications (DAILY_REMINDER, GOAL_COMPLETED, COINS_EARNED, EVENT_REMINDER, TREE_MILESTONE) with automatic FCM delivery.',
    security: secured,
    middleware: [requireUser] as const,
    request: {
      body: {
        content: { 'application/json': { schema: predefinedNotificationBodySchema } },
        required: true,
      },
    },
    responses: {
      200: jsonOk(
        z.object({
          id: z.number().int(),
          pushCount: z.number().int(),
        }),
        'Notification dispatched',
      ),
      400: errorResponses[400],
      401: errorResponses[401],
    },
  }),
  async (c) => {
    const user = c.get('user');
    const { type, params } = c.req.valid('json');
    const result = await sendPredefinedNotification(user.id, type, params);
    return ok(c, result, 200);
  },
);

/**
 * GET /api/v1/notifications
 * Lists in-app notifications for the authenticated user.
 */
notificationRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['notifications'],
    summary: 'In-app notifications',
    description: 'Paginated list of in-app notifications for the authenticated user.',
    middleware: [requireUser] as const,
    security: secured,
    request: { query: cursorQuery },
    responses: {
      200: jsonOk(paginated(notificationSchema), 'Notifications'),
      400: errorResponses[400],
      401: errorResponses[401],
    },
  }),
  async (c) => {
    const { cursor, limit } = c.req.valid('query');
    return ok(c, await refService.listNotifications(c.get('user').id, limit, cursor), 200);
  },
);

/**
 * PATCH /api/v1/notifications/{id}/read
 * Marks a single notification read.
 */
notificationRoutes.openapi(
  createRoute({
    method: 'patch',
    path: '/{id}/read',
    tags: ['notifications'],
    summary: 'Mark one notification read',
    middleware: [requireUser] as const,
    security: secured,
    request: { params: idParam },
    responses: {
      200: jsonOk(notificationSchema, 'Marked read'),
      401: errorResponses[401],
      404: errorResponses[404],
    },
  }),
  async (c) => ok(c, await refService.markRead(c.get('user').id, c.req.valid('param').id), 200),
);

/**
 * POST /api/v1/notifications/read-all
 * Marks all unread notifications read for the current user.
 */
notificationRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/read-all',
    tags: ['notifications'],
    summary: 'Mark all notifications read',
    middleware: [requireUser] as const,
    security: secured,
    responses: {
      200: jsonOk(z.object({ markedCount: z.number().int() }), 'All marked read'),
      401: errorResponses[401],
    },
  }),
  async (c) => {
    const user = c.get('user');
    const updated = await db
      .update(notifications)
      .set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
      .where(and(eq(notifications.userId, user.id), isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    return ok(c, { markedCount: updated.length }, 200);
  },
);
