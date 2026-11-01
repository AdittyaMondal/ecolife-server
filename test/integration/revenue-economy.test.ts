import { describe, expect, it } from 'bun:test';
import { freshIpHeaders } from '@common/testing/client-ip.ts';
import { createOnboardedUser } from '@common/testing/fixtures.ts';
import { app } from '../../src/app.ts';

const TIMEOUT = 60_000;

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

describe('Platform Revenue and Coin Economy (Part 7)', () => {
  it(
    'supports commission configuration, fixed coin rate, immutable double-entry ledger, and seller settlements',
    async () => {
      const admin = await createOnboardedUser({ role: 'admin' });
      const buyer = await createOnboardedUser({
        coinsBalance: 500,
        email: `buyer-${crypto.randomUUID().slice(0, 6)}@example.test`,
      });
      const sellerUser = await createOnboardedUser({
        email: `seller-${crypto.randomUUID().slice(0, 6)}@example.test`,
      });

      // 1. Guard check: regular user cannot access admin settings
      const unauthorizedRes = await call('/admin/settings', {
        method: 'GET',
        headers: auth(buyer.token),
      });
      expect(unauthorizedRes.status).toBe(403);

      // 2. Admin retrieves global settings
      const getSettingsRes = await json(
        await call('/admin/settings', {
          method: 'GET',
          headers: auth(admin.token),
        }),
      );
      expect(getSettingsRes.status).toBe(true);
      expect(getSettingsRes.data.defaultCommissionRateBps).toBeDefined();
      expect(getSettingsRes.data.coinsPerRupee).toBe(10);

      // 3. Admin updates global settings: commission to 10% (1000 bps), coin fee to 2% (200 bps)
      const patchSettingsRes = await json(
        await call('/admin/settings', {
          method: 'PATCH',
          headers: auth(admin.token),
          body: JSON.stringify({
            defaultCommissionRateBps: 1000,
            coinRedemptionFeeBps: 200,
            coinsPerRupee: 10,
            maxDiscountPercent: 20,
          }),
        }),
      );
      expect(patchSettingsRes.status).toBe(true);
      expect(patchSettingsRes.data.defaultCommissionRateBps).toBe(1000);
      expect(patchSettingsRes.data.defaultCommissionPercent).toBe(10);
      expect(patchSettingsRes.data.coinRedemptionFeeBps).toBe(200);

      // 4. Create and approve a Seller Partner Organization
      const orgName = `EcoStore ${crypto.randomUUID().slice(0, 6)}`;
      const createOrgRes = await json(
        await call('/organizations', {
          method: 'POST',
          headers: auth(sellerUser.token),
          body: JSON.stringify({
            name: orgName,
            type: 'seller',
            city: 'Bengaluru',
            regionCode: 'IN-KA',
            address: '42 Brigade Road',
            verificationDetails: { gstin: '29AAAAA0000A1Z5' },
          }),
        }),
      );
      expect(createOrgRes.status).toBe(true);
      const sellerOrgId = createOrgRes.data.id as number;

      // Admin approves seller
      await call(`/admin/organizations/${sellerOrgId}/review`, {
        method: 'POST',
        headers: auth(admin.token),
        body: JSON.stringify({
          decision: 'approve',
          expected: { name: orgName, logoUrl: null, websiteUrl: null },
        }),
      });

      // 5. Admin sets custom commission override for this seller: 12% (1200 bps)
      const setOverrideRes = await json(
        await call(`/admin/settings/sellers/${sellerOrgId}/commission`, {
          method: 'PUT',
          headers: auth(admin.token),
          body: JSON.stringify({ commissionRateBps: 1200 }),
        }),
      );
      expect(setOverrideRes.status).toBe(true);
      expect(setOverrideRes.data.commissionRateBps).toBe(1200);
      expect(setOverrideRes.data.effectiveCommissionRateBps).toBe(1200);
      expect(setOverrideRes.data.effectiveCommissionPercent).toBe(12.0);

      // 6. Seller creates a product (Base price = ₹200.00 = 20,000 paise)
      const createProductRes = await json(
        await call('/seller/products', {
          method: 'POST',
          headers: auth(sellerUser.token),
          body: JSON.stringify({
            name: 'Organic Cotton Tote',
            category: 'household',
            pricePaise: 20000,
            stock: 25,
            allowCoinRedemption: true,
            maxCoinRedemptionPercent: 20,
          }),
        }),
      );
      expect(createProductRes.status).toBe(true);
      const product = createProductRes.data;

      // 7. Buyer adds address, cart item, and checks out with 100 coins
      const addressRes = await json(
        await call('/addresses', {
          method: 'POST',
          headers: auth(buyer.token),
          body: JSON.stringify({
            name: 'Buyer User',
            phone: '+919876543210',
            line1: '100 MG Road',
            city: 'Bengaluru',
            state: 'Karnataka',
            pincode: '560001',
            isDefault: true,
          }),
        }),
      );
      expect(addressRes.status).toBe(true);
      const addressId = addressRes.data.id;

      await call('/marketplace/cart/items', {
        method: 'POST',
        headers: auth(buyer.token),
        body: JSON.stringify({
          productId: product.id,
          quantity: 1,
        }),
      });

      // 100 coins = ₹10.00 discount (1,000 paise)
      const placeOrderRes = await json(
        await call('/marketplace/orders', {
          method: 'POST',
          headers: auth(buyer.token),
          body: JSON.stringify({
            addressId,
            offeredCoins: 100,
            idempotencyKey: crypto.randomUUID(),
          }),
        }),
      );
      expect(placeOrderRes.status).toBe(true);
      const order = placeOrderRes.data;
      expect(order.subtotalPaise).toBe(20000);
      expect(order.discountPaise).toBe(1000);
      expect(order.totalPaise).toBe(19000);
      expect(order.coinsSpent).toBe(100);

      // 8. Verify Order Settlement record created in database
      const settlementsRes = await json(
        await call(`/admin/revenue/settlements?sellerOrgId=${sellerOrgId}`, {
          method: 'GET',
          headers: auth(admin.token),
        }),
      );
      expect(settlementsRes.status).toBe(true);
      expect(settlementsRes.data.items.length).toBeGreaterThanOrEqual(1);

      const settlement = settlementsRes.data.items.find(
        (s: { orderId: number }) => s.orderId === order.id,
      );
      expect(settlement).toBeDefined();
      expect(settlement.saleAmountPaise).toBe(20000);
      expect(settlement.coinsUsed).toBe(100);
      expect(settlement.coinValuePaise).toBe(1000);
      expect(settlement.cashPaidPaise).toBe(19000);
      expect(settlement.commissionRateBps).toBe(1200); // 12% seller override
      expect(settlement.salesCommissionPaise).toBe(2400); // 12% of 20000
      expect(settlement.coinFeeRateBps).toBe(200); // 2% coin fee
      expect(settlement.coinFeePaise).toBe(20); // 2% of 1000
      expect(settlement.platformCommissionPaise).toBe(2420); // 2400 + 20
      expect(settlement.sellerPayoutPaise).toBe(17580); // 20000 - 2420
      expect(settlement.status).toBe('pending');

      // Strict mathematical invariants
      expect(settlement.sellerPayoutPaise + settlement.platformCommissionPaise).toBe(
        settlement.saleAmountPaise,
      );
      expect(settlement.cashPaidPaise + settlement.coinValuePaise).toBe(
        settlement.saleAmountPaise,
      );

      // 9. Verify Immutable Settlement Ledger entries
      const ledgerRes = await json(
        await call(`/admin/revenue/ledger?orderId=${order.id}`, {
          method: 'GET',
          headers: auth(admin.token),
        }),
      );
      expect(ledgerRes.status).toBe(true);
      expect(ledgerRes.data.items.length).toBe(4);
      const types = ledgerRes.data.items.map((i: { transactionType: string }) => i.transactionType);
      expect(types).toContain('sale_commission');
      expect(types).toContain('coin_subsidy');
      expect(types).toContain('coin_fee');
      expect(types).toContain('seller_payout');

      // 10. Admin processes Seller Payout batch
      const payoutRes = await json(
        await call('/admin/revenue/payouts', {
          method: 'POST',
          headers: auth(admin.token),
          body: JSON.stringify({
            sellerOrgId,
            referenceNote: 'UPI Transfer Ref: UPI-9876543210',
          }),
        }),
      );
      expect(payoutRes.status).toBe(true);
      expect(payoutRes.data.payoutNumber).toMatch(/^PAY-\d{4}-\d{5}$/);
      expect(payoutRes.data.totalAmountPaise).toBe(17580);
      expect(payoutRes.data.settlementCount).toBe(1);

      // 11. Verify settlement updated to 'settled'
      const updatedSettlementsRes = await json(
        await call(`/admin/revenue/settlements?sellerOrgId=${sellerOrgId}&status=settled`, {
          method: 'GET',
          headers: auth(admin.token),
        }),
      );
      expect(updatedSettlementsRes.status).toBe(true);
      const settledItem = updatedSettlementsRes.data.items.find(
        (s: { orderId: number }) => s.orderId === order.id,
      );
      expect(settledItem.status).toBe('settled');
      expect(settledItem.payoutId).toBe(payoutRes.data.id);

      // 12. Verify Revenue Analytics
      const analyticsRes = await json(
        await call('/admin/revenue/analytics', {
          method: 'GET',
          headers: auth(admin.token),
        }),
      );
      expect(analyticsRes.status).toBe(true);
      expect(analyticsRes.data.grossMerchandiseValuePaise).toBeGreaterThanOrEqual(20000);
      expect(analyticsRes.data.totalCashCollectedPaise).toBeGreaterThanOrEqual(19000);
      expect(analyticsRes.data.totalCoinDiscountPaise).toBeGreaterThanOrEqual(1000);
      expect(analyticsRes.data.totalCoinsRedeemed).toBeGreaterThanOrEqual(100);
      expect(analyticsRes.data.platformRevenuePaise).toBeGreaterThanOrEqual(2420);
      expect(analyticsRes.data.settledSellerPayoutsPaise).toBeGreaterThanOrEqual(17580);
      expect(analyticsRes.data.monthlyBreakdown).toBeDefined();
    },
    TIMEOUT,
  );
});
