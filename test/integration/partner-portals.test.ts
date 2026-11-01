import { describe, expect, it } from 'bun:test';
import { freshIpHeaders } from '@common/testing/client-ip.ts';
import { createOnboardedUser } from '@common/testing/fixtures.ts';
import { app } from '../../src/app.ts';

const TIMEOUT = 30_000;

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
  error: { code: string; message: string; details: unknown };
};

const json = async (r: Response) => (await r.json()) as unknown as Envelope;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('Partner Types Registration & Portals (Part 1)', () => {
  it(
    'supports registering Corporate, Community, and Marketplace partners with verification details',
    async () => {
      const user = await createOnboardedUser({
        email: `test-partner-${crypto.randomUUID().slice(0, 6)}@example.test`,
      });

      const res = await json(
        await call('/organizations', {
          method: 'POST',
          headers: auth(user.token),
          body: JSON.stringify({
            name: `GreenCorp ${crypto.randomUUID().slice(0, 8)}`,
            type: 'industry',
            city: 'Bengaluru',
            regionCode: 'IN-KA',
            verificationDetails: {
              taxId: '29ABCDE1234F1Z5',
              registrationNumber: 'U72200KA2020PTC123456',
              workforceSize: '50-200',
            },
          }),
        }),
      );

      expect(res.status).toBe(true);
      expect(res.data.type).toBe('industry');
      expect(res.data.status).toBe('pending');
      expect(res.data.verificationDetails).toEqual({
        taxId: '29ABCDE1234F1Z5',
        registrationNumber: 'U72200KA2020PTC123456',
        workforceSize: '50-200',
      });

      // Verify GET /organizations/me returns it
      const meRes = await json(
        await call('/organizations/me', {
          headers: auth(user.token),
        }),
      );

      expect(meRes.status).toBe(true);
      expect(meRes.data.role).toBe('owner');
      expect(meRes.data.organization.type).toBe('industry');
      expect(meRes.data.organization.status).toBe('pending');
      expect(meRes.data.organization.verificationDetails.taxId).toBe('29ABCDE1234F1Z5');
    },
    TIMEOUT,
  );

  it(
    'supports Marketplace Partner (seller) registration with store details',
    async () => {
      const sellerUser = await createOnboardedUser({
        email: `seller-partner-${crypto.randomUUID().slice(0, 6)}@example.test`,
      });

      const res = await json(
        await call('/organizations', {
          method: 'POST',
          headers: auth(sellerUser.token),
          body: JSON.stringify({
            name: `EcoCrafts ${crypto.randomUUID().slice(0, 8)}`,
            type: 'seller',
            city: 'Mumbai',
            regionCode: 'IN-MH',
            verificationDetails: {
              gstin: '27AABCU9603R1ZM',
              storeCategory: 'household',
              businessAddress: '102 Green St, Bandra, Mumbai',
            },
          }),
        }),
      );

      expect(res.status).toBe(true);
      expect(res.data.type).toBe('seller');
      expect(res.data.status).toBe('pending');
      expect(res.data.verificationDetails.storeCategory).toBe('household');
    },
    TIMEOUT,
  );
});
