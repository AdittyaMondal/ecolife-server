import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { env } from '@config/env.ts';
import { db } from '@database/client.ts';
import { notifications, pushTokens } from '@database/schema/index.ts';
import { and, eq, inArray } from 'drizzle-orm';
import { cert, type App as FirebaseApp, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging, type Messaging } from 'firebase-admin/messaging';

export type PredefinedNotificationType =
  | 'DAILY_REMINDER'
  | 'GOAL_COMPLETED'
  | 'COINS_EARNED'
  | 'EVENT_REMINDER'
  | 'TREE_MILESTONE';

export interface PredefinedTemplate {
  title: string;
  body: string;
  linkPath: string;
}

export const PREDEFINED_TEMPLATES: Record<
  PredefinedNotificationType,
  (params?: Record<string, string>) => PredefinedTemplate
> = {
  DAILY_REMINDER: () => ({
    title: 'Time to Log Your Day! 🌱',
    body: 'Keep your eco-streak alive. Log your transport, food, and energy habits today.',
    linkPath: '/track',
  }),
  GOAL_COMPLETED: (p) => ({
    title: 'Goal Achieved! 🎯',
    body: p?.goalTitle
      ? `Awesome job! You completed your goal: "${p.goalTitle}".`
      : 'Awesome job reducing your carbon footprint today! You reached your goal.',
    linkPath: '/goals',
  }),
  COINS_EARNED: (p) => ({
    title: 'Eco-Coins Earned! 🪙',
    body: p?.coins
      ? `You just earned ${p.coins} Eco-Coins for your sustainable choices!`
      : 'You earned Eco-Coins for your eco-friendly actions!',
    linkPath: '/home',
  }),
  EVENT_REMINDER: (p) => ({
    title: 'Eco Event Reminder 🎟️',
    body: p?.eventName
      ? `Your registered event "${p.eventName}" is coming up! Have your pass ready.`
      : 'Your registered eco event is coming up soon! Have your pass ready.',
    linkPath: p?.eventId ? `/events/${p.eventId}` : '/events',
  }),
  TREE_MILESTONE: (p) => ({
    title: 'Your Tree Leveled Up! 🌳',
    body: p?.level
      ? `Your efforts are making an impact! Your virtual tree reached level ${p.level}.`
      : 'Your virtual tree has grown stronger thanks to your green habits!',
    linkPath: '/trees',
  }),
};

let firebaseApp: FirebaseApp | null = null;
let messagingInstance: Messaging | null = null;

/**
 * Initializes Firebase Admin using serviceAccount.json or environment variables.
 * Safe to call multiple times (cached).
 */
export function getFirebaseMessaging(): Messaging | null {
  if (messagingInstance) return messagingInstance;

  const existingApps = getApps();
  if (existingApps.length > 0 && existingApps[0]) {
    firebaseApp = existingApps[0];
    messagingInstance = getMessaging(firebaseApp);
    return messagingInstance;
  }

  try {
    const localSaPath = resolve(process.cwd(), 'serviceAccount.json');
    if (existsSync(localSaPath)) {
      const sa = JSON.parse(readFileSync(localSaPath, 'utf8'));
      firebaseApp = initializeApp({ credential: cert(sa) });
      messagingInstance = getMessaging(firebaseApp);
      return messagingInstance;
    }

    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      firebaseApp = initializeApp({ credential: cert(sa) });
      messagingInstance = getMessaging(firebaseApp);
      return messagingInstance;
    }

    // Default fallback to project
    firebaseApp = initializeApp({ projectId: 'ecolife-9c78c' });
    messagingInstance = getMessaging(firebaseApp);
    return messagingInstance;
  } catch (err) {
    console.warn('[FCM] Firebase messaging failed to initialize:', err);
    return null;
  }
}

/**
 * Saves or updates a device push token for an authenticated user.
 */
export async function registerPushToken(
  userId: number,
  token: string,
  platform = 'android',
): Promise<void> {
  await db
    .insert(pushTokens)
    .values({
      userId,
      token,
      platform,
    })
    .onConflictDoUpdate({
      target: pushTokens.token,
      set: {
        userId,
        platform,
        createdAt: new Date(),
      },
    });
}

/**
 * Removes a push token (e.g. on logout).
 */
export async function unregisterPushToken(userId: number, token: string): Promise<void> {
  await db
    .delete(pushTokens)
    .where(and(eq(pushTokens.userId, userId), eq(pushTokens.token, token)));
}

/**
 * Dispatches a predefined notification:
 * 1. Inserts the in-app notification row into the `notifications` table.
 * 2. Fetches all registered device tokens for the user.
 * 3. Sends FCM push notification formatted for Android.
 * 4. Automatically purges dead or invalidated tokens.
 */
export async function sendPredefinedNotification(
  userId: number,
  type: PredefinedNotificationType,
  params?: Record<string, string>,
): Promise<{ id: number; pushCount: number }> {
  const templateFn = PREDEFINED_TEMPLATES[type] ?? PREDEFINED_TEMPLATES.DAILY_REMINDER;
  const { title, body, linkPath } = templateFn(params);

  // 1. Store in-app notification
  const [created] = await db
    .insert(notifications)
    .values({
      userId,
      type,
      title,
      body,
      linkPath,
    })
    .returning({ id: notifications.id });

  const notifId = created?.id ?? 0;

  // 2. Fetch user's push tokens
  const rows = await db
    .select({ token: pushTokens.token, platform: pushTokens.platform })
    .from(pushTokens)
    .where(eq(pushTokens.userId, userId));

  if (rows.length === 0) {
    return { id: notifId, pushCount: 0 };
  }

  const messaging = getFirebaseMessaging();
  if (!messaging) {
    return { id: notifId, pushCount: 0 };
  }

  const tokens = rows.map((r) => r.token);
  const invalidTokens: string[] = [];

  try {
    const response = await messaging.sendEachForMulticast({
      tokens,
      notification: {
        title,
        body,
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'default',
          color: '#1B4D3E',
          sound: 'default',
          clickAction: 'FLUTTER_NOTIFICATION_CLICK',
        },
      },
      data: {
        notifId: String(notifId),
        type,
        linkPath,
        ...(params ?? {}),
      },
    });

    response.responses.forEach((resp, idx) => {
      if (!resp.success && resp.error) {
        const code = resp.error.code;
        if (
          code === 'messaging/invalid-registration-token' ||
          code === 'messaging/registration-token-not-registered'
        ) {
          const t = tokens[idx];
          if (t) invalidTokens.push(t);
        }
      }
    });

    if (invalidTokens.length > 0) {
      await db.delete(pushTokens).where(inArray(pushTokens.token, invalidTokens));
    }

    return { id: notifId, pushCount: response.successCount };
  } catch (err) {
    console.error('[FCM] Error dispatching push notification:', err);
    return { id: notifId, pushCount: 0 };
  }
}
