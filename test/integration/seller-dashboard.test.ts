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

describe('Marketplace Partner (Seller) Dashboard (Part 6)', () => {
  it(
    'supports shop profile, product catalog with discounts, orders, and sales reports',
    async () => {
      const sellerUser = await createOnboardedUser({
        email: `seller-lead-${crypto.randomUUID().slice(0, 6)}@example.test`,
      });
      const admin = await createOnboardedUser({ role: 'admin' });

      // 1. Create seller organization
      const createOrgRes = await json(
        await call('/organizations', {
          method: 'POST',
          headers: auth(sellerUser.token),
          body: JSON.stringify({
            name: `EcoCrafts Store ${crypto.randomUUID().slice(0, 6)}`,
            type: 'seller',
            city: 'Jaipur',
            regionCode: 'IN-RJ',
            address: 'Shop 14, Bapu Bazaar, Jaipur',
            verificationDetails: {
              gstin: '08AAAAA0000A1Z5',
              storeCategories: ['personal_care', 'household'],
            },
          }),
        }),
      );
      expect(createOrgRes.status).toBe(true);
      const sellerOrgId = createOrgRes.data.id;

      // 2. Approve seller as admin
      const approveRes = await json(
        await call(`/admin/organizations/${sellerOrgId}/review`, {
          method: 'POST',
          headers: auth(admin.token),
          body: JSON.stringify({
            decision: 'approve',
            note: 'Approved for test',
            expected: { name: createOrgRes.data.name, logoUrl: null, websiteUrl: null },
          }),
        }),
      );
      expect(approveRes.status).toBe(true);

      // 3. Shop profile management (Requirement 21)
      const updateProfileRes = await json(
        await call(`/organizations/${sellerOrgId}`, {
          method: 'PATCH',
          headers: auth(sellerUser.token),
          body: JSON.stringify({
            description: 'Handcrafted sustainable goods made from organic materials.',
            contactPhone: '+911412345678',
            address: 'Shop 14-16, Heritage Wing, Bapu Bazaar, Jaipur',
          }),
        }),
      );
      expect(updateProfileRes.status).toBe(true);
      expect(updateProfileRes.data.address).toBe('Shop 14-16, Heritage Wing, Bapu Bazaar, Jaipur');

      // 4. Product management & discounts (Requirements 22 & 23)
      const createProdRes = await json(
        await call('/seller/products', {
          method: 'POST',
          headers: auth(sellerUser.token),
          body: JSON.stringify({
            name: 'Handmade Neem Comb',
            description: 'Natural antiseptic neem wood comb.',
            category: 'personal_care',
            pricePaise: 20000, // 200 INR
            stock: 25,
            co2SavedKg: 0.8,
            discountType: 'percentage',
            discountValue: 10, // 10% discount -> 180 INR effective
            allowCoinRedemption: true,
            maxCoinRedemptionPercent: 20,
            imageUrl: 'https://images.unsplash.com/photo-1592150621744-aca64f48394a',
            images: ['https://images.unsplash.com/photo-1592150621744-aca64f48394a'],
          }),
        }),
      );
      expect(createProdRes.status).toBe(true);
      const prod = createProdRes.data;
      expect(prod.name).toBe('Handmade Neem Comb');
      expect(prod.pricePaise).toBe(20000);
      expect(prod.effectivePricePaise).toBe(18000);
      expect(prod.discountType).toBe('percentage');
      expect(prod.discountValue).toBe(10);
      expect(prod.sellerOrgId).toBe(sellerOrgId);

      // List seller products
      const listProdRes = await json(
        await call('/seller/products', {
          headers: auth(sellerUser.token),
        }),
      );
      expect(listProdRes.status).toBe(true);
      expect(listProdRes.data.items.length).toBeGreaterThanOrEqual(1);

      // Edit product stock and price
      const updateProdRes = await json(
        await call(`/seller/products/${prod.id}`, {
          method: 'PATCH',
          headers: auth(sellerUser.token),
          body: JSON.stringify({
            stock: 50,
            discountValue: 15, // 15% discount -> 170 INR effective
          }),
        }),
      );
      expect(updateProdRes.status).toBe(true);
      expect(updateProdRes.data.stock).toBe(50);
      expect(updateProdRes.data.effectivePricePaise).toBe(17000);

      // 5. Customer buys product with coin redemption
      const customer = await createOnboardedUser({
        email: `buyer-${crypto.randomUUID().slice(0, 6)}@example.test`,
        coinsBalance: 100,
      });

      // Add address
      const addrRes = await json(
        await call('/addresses', {
          method: 'POST',
          headers: auth(customer.token),
          body: JSON.stringify({
            name: 'Priya Buyer',
            phone: '+919876543210',
            line1: '42 Lotus Lane',
            line2: null,
            city: 'Jaipur',
            state: 'Rajasthan',
            pincode: '302001',
            isDefault: true,
          }),
        }),
      );
      expect(addrRes.status).toBe(true);
      const addressId = addrRes.data.id;

      // Add to cart & place order
      await call('/marketplace/cart/items', {
        method: 'POST',
        headers: auth(customer.token),
        body: JSON.stringify({ productId: prod.id, quantity: 2 }),
      });

      const orderRes = await json(
        await call('/marketplace/orders', {
          method: 'POST',
          headers: auth(customer.token),
          body: JSON.stringify({
            offeredCoins: 50,
            addressId,
            idempotencyKey: crypto.randomUUID(),
          }),
        }),
      );
      expect(orderRes.status).toBe(true);
      const placedOrder = orderRes.data;

      // 6. Seller views order and redemptions (Requirement 24)
      const sellerOrdersRes = await json(
        await call('/seller/orders', {
          headers: auth(sellerUser.token),
        }),
      );
      expect(sellerOrdersRes.status).toBe(true);
      expect(sellerOrdersRes.data.items.length).toBeGreaterThanOrEqual(1);

      const sellerOrder = sellerOrdersRes.data.items.find((o: any) => o.id === placedOrder.id);
      expect(sellerOrder).toBeDefined();
      expect(sellerOrder.customer.id).toBe(customer.userId);
      expect(sellerOrder.items[0].productName).toBe('Handmade Neem Comb');
      expect(sellerOrder.items[0].quantity).toBe(2);

      // Seller updates fulfillment status
      const statusUpdateRes = await json(
        await call(`/seller/orders/${placedOrder.id}/status`, {
          method: 'PATCH',
          headers: auth(sellerUser.token),
          body: JSON.stringify({ status: 'confirmed' }),
        }),
      );
      expect(statusUpdateRes.status).toBe(true);
      expect(statusUpdateRes.data.status).toBe('confirmed');

      // 7. Seller reports and analytics (Requirement 24)
      const analyticsRes = await json(
        await call('/seller/analytics', {
          headers: auth(sellerUser.token),
        }),
      );
      expect(analyticsRes.status).toBe(true);
      expect(analyticsRes.data.totalSalesVolumePaise).toBeGreaterThan(0);
      expect(analyticsRes.data.totalUnitsSoldCount).toBe(2);
      expect(analyticsRes.data.activeProductsCount).toBeGreaterThanOrEqual(1);
      expect(analyticsRes.data.topProducts.length).toBeGreaterThanOrEqual(1);
    },
    TIMEOUT,
  );
});
