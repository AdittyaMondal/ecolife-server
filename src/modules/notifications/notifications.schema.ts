import { z } from '@hono/zod-openapi';

export const pushTokenBodySchema = z
  .object({
    token: z
      .string()
      .min(10)
      .openapi({ example: 'f-abc123xyz...', description: 'FCM device token' }),
    platform: z
      .enum(['android', 'ios'])
      .default('android')
      .openapi({ example: 'android', description: 'Device OS platform' }),
  })
  .openapi('PushTokenBody');

export const deletePushTokenBodySchema = z
  .object({
    token: z.string().min(10).openapi({ example: 'f-abc123xyz...' }),
  })
  .openapi('DeletePushTokenBody');

export const predefinedNotificationBodySchema = z
  .object({
    type: z
      .enum([
        'DAILY_REMINDER',
        'GOAL_COMPLETED',
        'COINS_EARNED',
        'EVENT_REMINDER',
        'TREE_MILESTONE',
      ])
      .openapi({ example: 'DAILY_REMINDER', description: 'Predefined notification type' }),
    params: z
      .record(z.string(), z.string())
      .optional()
      .openapi({
        example: { coins: '50' },
        description: 'Template parameter substitutions',
      }),
  })
  .openapi('PredefinedNotificationBody');

export const notificationSchema = z
  .object({
    id: z.number().int().openapi({ example: 42 }),
    type: z.string().openapi({ example: 'DAILY_REMINDER' }),
    title: z.string().openapi({ example: 'Time to Log Your Day! 🌱' }),
    body: z
      .string()
      .nullable()
      .openapi({ example: 'Keep your eco-streak alive. Log your habits today.' }),
    linkPath: z.string().nullable().openapi({ example: '/track' }),
    readAt: z.string().nullable().openapi({ example: '2026-11-01T10:00:00.000Z' }),
    createdAt: z.string().openapi({ example: '2026-11-01T09:00:00.000Z' }),
  })
  .openapi('Notification');
