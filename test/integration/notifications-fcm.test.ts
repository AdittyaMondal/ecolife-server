import { describe, expect, it } from 'bun:test';
import { freshIpHeaders } from '@common/testing/client-ip.ts';
import { db } from '@database/client.ts';
import { notifications, pushTokens } from '@database/schema/index.ts';
import { eq } from 'drizzle-orm';
import { app } from '../../src/app.ts';
import { PREDEFINED_TEMPLATES } from '../../src/modules/notifications/fcm.service.ts';

const TIMEOUT = 30_000;
const PW = 'correct horse battery staple';

const call = (path: string, init: RequestInit = {}) =>
  app.request(`/api/v1${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...freshIpHeaders(),
      ...(init.headers ?? {}),
    },
  });

type Envelope = {
  status: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: test helper
  data: any;
  // biome-ignore lint/suspicious/noExplicitAny: test helper
  error: { code: string; message: string; details: any };
};
const json = async (r: Response) => (await r.json()) as unknown as Envelope;

async function signUp() {
  const addr = `fcm-${crypto.randomUUID()}@example.test`;
  const res = await call('/auth/register', {
    method: 'POST',
    headers: { 'x-ecolife-platform': 'android' },
    body: JSON.stringify({ name: 'FCM Tester', email: addr, password: PW }),
  });
  const body = await json(res);
  return { token: body.data.session.accessToken as string, userId: body.data.user.id as number };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('Notifications & FCM Integration', () => {
  it(
    'has valid predefined notification templates',
    () => {
      const daily = PREDEFINED_TEMPLATES.DAILY_REMINDER();
      expect(daily.title).toContain('Log Your Day');
      expect(daily.linkPath).toBe('/track');

      const coins = PREDEFINED_TEMPLATES.COINS_EARNED({ coins: '25' });
      expect(coins.body).toContain('25 Eco-Coins');
      expect(coins.linkPath).toBe('/home');

      const goal = PREDEFINED_TEMPLATES.GOAL_COMPLETED({ goalTitle: 'Plastic Reduction' });
      expect(goal.body).toContain('Plastic Reduction');
      expect(goal.linkPath).toBe('/goals');

      const event = PREDEFINED_TEMPLATES.EVENT_REMINDER({
        eventId: '10',
        eventName: 'Beach Cleanup',
      });
      expect(event.body).toContain('Beach Cleanup');
      expect(event.linkPath).toBe('/events/10');

      const tree = PREDEFINED_TEMPLATES.TREE_MILESTONE({ level: '3' });
      expect(tree.body).toContain('level 3');
      expect(tree.linkPath).toBe('/trees');
    },
    TIMEOUT,
  );

  it(
    'registers and unregisters FCM push tokens for Android device',
    async () => {
      const { token, userId } = await signUp();
      const testToken = `fcm-token-${crypto.randomUUID()}-for-android-test`;

      // 1. Register push token
      const regRes = await call('/notifications/push-token', {
        method: 'POST',
        headers: auth(token),
        body: JSON.stringify({ token: testToken, platform: 'android' }),
      });
      expect(regRes.status).toBe(200);
      const regBody = await json(regRes);
      expect(regBody.data.registered).toBe(true);

      // Verify in DB
      const [saved] = await db.select().from(pushTokens).where(eq(pushTokens.token, testToken));
      // `toBeDefined()` does not narrow for TypeScript, so assert then use the
      // optional chain — `saved!` would trip biome's noNonNullAssertion.
      expect(saved).toBeDefined();
      expect(saved?.userId).toBe(userId);
      expect(saved?.platform).toBe('android');

      // 2. Unregister push token
      const unregRes = await call('/notifications/push-token', {
        method: 'DELETE',
        headers: auth(token),
        body: JSON.stringify({ token: testToken }),
      });
      expect(unregRes.status).toBe(200);
      const unregBody = await json(unregRes);
      expect(unregBody.data.unregistered).toBe(true);

      const [removed] = await db.select().from(pushTokens).where(eq(pushTokens.token, testToken));
      expect(removed).toBeUndefined();
    },
    TIMEOUT,
  );

  it(
    'dispatches predefined notifications and lists them in user in-app notifications',
    async () => {
      const { token, userId } = await signUp();

      // Dispatch predefined COINS_EARNED notification
      const sendRes = await call('/notifications/send-predefined', {
        method: 'POST',
        headers: auth(token),
        body: JSON.stringify({
          type: 'COINS_EARNED',
          params: { coins: '100' },
        }),
      });
      expect(sendRes.status).toBe(200);
      const sendBody = await json(sendRes);
      expect(sendBody.data.id).toBeGreaterThan(0);

      // List notifications
      const listRes = await call('/notifications', { headers: auth(token) });
      expect(listRes.status).toBe(200);
      const listBody = await json(listRes);
      expect(listBody.data.items.length).toBeGreaterThanOrEqual(1);

      const item = listBody.data.items[0];
      expect(item.type).toBe('COINS_EARNED');
      expect(item.title).toContain('Eco-Coins');
      expect(item.body).toContain('100');
      expect(item.readAt).toBeNull();

      // Mark all read
      const markAllRes = await call('/notifications/read-all', {
        method: 'POST',
        headers: auth(token),
      });
      expect(markAllRes.status).toBe(200);

      // Verify marked
      const refreshedRes = await call('/notifications', { headers: auth(token) });
      const refreshedBody = await json(refreshedRes);
      expect(refreshedBody.data.items[0].readAt).not.toBeNull();
    },
    TIMEOUT,
  );
});
