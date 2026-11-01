import { nullable } from '@common/openapi/envelope.ts';
import { moneySchema } from '@common/openapi/shared-schemas.ts';
import { z } from '@hono/zod-openapi';

/** PRD-v2 §6.5. Coins buy a discount, capped at 20%. All money is integer paise. */

export const productCategorySchema = z
  .enum(['plants', 'household', 'personal_care', 'kitchen', 'stationery'])
  .openapi({ example: 'plants' });

export const discountTypeSchema = z
  .enum(['none', 'percentage', 'fixed'])
  .openapi({ example: 'percentage' });

export const productSchema = z
  .object({
    id: z.number().int().openapi({ example: 12 }),
    slug: z.string().openapi({ example: 'tulsi-plant' }),
    name: z.string().openapi({ example: 'Tulsi plant, terracotta pot' }),
    description: z.string().nullable().openapi({ example: 'Grown without synthetic fertiliser.' }),
    category: productCategorySchema,
    pricePaise: moneySchema,
    effectivePricePaise: moneySchema.optional(),
    imageUrl: z.string().nullable().openapi({
      example:
        'https://images.unsplash.com/photo-1592150621744-aca64f48394a?auto=format&fit=crop&w=800&q=80',
    }),
    images: z.array(z.string()).default([]),
    stock: z.number().int().openapi({ example: 34 }),
    co2SavedKg: z
      .number()
      .nullable()
      .openapi({ example: 21.9, description: 'Why the product exists. Shown on the card.' }),
    sellerOrgId: z.number().int().nullable().optional(),
    sellerName: z.string().nullable().optional(),
    discountType: discountTypeSchema.default('none'),
    discountValue: z.number().int().min(0).default(0),
    discountStartDate: z.string().nullable().optional(),
    discountEndDate: z.string().nullable().optional(),
    allowCoinRedemption: z.boolean().default(true),
    maxCoinRedemptionPercent: z.number().int().min(0).max(100).default(20),
    isActive: z.boolean().default(true),
  })
  .openapi('Product');

export const productQuerySchema = z.object({
  category: productCategorySchema.optional().openapi({ param: { name: 'category', in: 'query' } }),
  q: z
    .string()
    .optional()
    .openapi({ param: { name: 'q', in: 'query' } }),
  sort: z
    .enum(['newest', 'price_asc', 'price_desc', 'co2_desc'])
    .default('newest')
    .openapi({ param: { name: 'sort', in: 'query' } }),
  cursor: z
    .string()
    .optional()
    .openapi({ param: { name: 'cursor', in: 'query' } }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .default(20)
    .openapi({
      param: { name: 'limit', in: 'query' },
    }),
});

export const cartItemSchema = z
  .object({
    productId: z.number().int().openapi({ example: 12 }),
    product: productSchema,
    quantity: z.number().int().min(1).openapi({ example: 2 }),
    lineTotalPaise: moneySchema,
  })
  .openapi('CartItem');

/**
 * The quote is always computed server-side. The client's `offeredCoins` is a
 * preview; the order is priced by the server, and a DB check constraint rejects
 * any row where discount exceeds 20% of subtotal.
 */
export const cartQuoteSchema = z
  .object({
    items: z.array(cartItemSchema),
    subtotalPaise: moneySchema,
    maxDiscountPaise: moneySchema.openapi({ description: '20% of subtotal, floored' }),
    discountPaise: moneySchema,
    totalPaise: moneySchema,
    coinsSpent: z.number().int().openapi({ example: 480 }),
    coinsBalanceAfter: z.number().int().openapi({ example: 0 }),
    coinsPerRupee: z.number().int().openapi({ example: 10 }),
    capReached: z
      .boolean()
      .openapi({ example: true, description: 'True when the 20% cap bound the discount' }),
  })
  .openapi('CartQuote');

export const previewBodySchema = z
  .object({ offeredCoins: z.number().int().min(0).openapi({ example: 2000 }) })
  .openapi('CartPreviewBody');

export const addCartItemBodySchema = z
  .object({
    productId: z.number().int().openapi({ example: 12 }),
    quantity: z.number().int().min(1).max(20).default(1).openapi({ example: 1 }),
  })
  .openapi('AddCartItemBody');

export const addressSchema = z
  .object({
    id: z.number().int().openapi({ example: 2 }),
    name: z.string().openapi({ example: 'Adittya' }),
    phone: z.string().openapi({ example: '+919876543210' }),
    line1: z.string().openapi({ example: '12 Hill Road' }),
    line2: z.string().nullable().optional().openapi({ example: null }),
    city: z.string().openapi({ example: 'Mumbai' }),
    state: z.string().openapi({ example: 'Maharashtra' }),
    pincode: z.string().openapi({ example: '400050' }),
    isDefault: z.boolean().openapi({ example: true }),
  })
  .openapi('Address');

export const addressBodySchema = addressSchema.omit({ id: true }).openapi('AddressBody');

export const orderStatusSchema = z
  .enum(['placed', 'confirmed', 'shipped', 'delivered', 'cancelled'])
  .openapi({ example: 'placed' });

export const orderSchema = z
  .object({
    id: z.number().int().openapi({ example: 101 }),
    orderNumber: z.string().openapi({ example: 'ECO-2026-00042' }),
    items: z
      .array(
        z.object({
          productName: z.string().openapi({ example: 'Tulsi plant, terracotta pot' }),
          unitPaise: moneySchema,
          quantity: z.number().int().openapi({ example: 2 }),
        }),
      )
      .openapi({
        description: 'Name and price are snapshots — a later rename never rewrites history',
      }),
    subtotalPaise: moneySchema,
    discountPaise: moneySchema,
    totalPaise: moneySchema,
    coinsSpent: z.number().int().openapi({ example: 480 }),
    status: orderStatusSchema,
    address: nullable(addressSchema),
    createdAt: z.string().openapi({ example: '2026-10-31T10:02:00.000Z' }),
  })
  .openapi('Order');

export const placeOrderBodySchema = z
  .object({
    offeredCoins: z.number().int().min(0).openapi({ example: 480 }),
    addressId: z.number().int().openapi({ example: 2 }),
    idempotencyKey: z.string().uuid().openapi({ example: '0193f0b1-55aa-7c3d-8e21-9f0a1b2c3d4e' }),
  })
  .openapi('PlaceOrderBody');

export const createSellerProductBodySchema = z
  .object({
    name: z.string().min(2).max(120).openapi({ example: 'Eco Bamboo Toothbrush' }),
    slug: z.string().min(2).max(140).optional().openapi({ example: 'eco-bamboo-toothbrush' }),
    description: z
      .string()
      .max(2000)
      .optional()
      .openapi({ example: '100% biodegradable handle with charcoal bristles.' }),
    category: productCategorySchema,
    pricePaise: z
      .number()
      .int()
      .min(0)
      .openapi({ example: 19900, description: 'Base price in paise' }),
    imageUrl: z
      .string()
      .url()
      .nullable()
      .optional()
      .openapi({ example: 'https://images.unsplash.com/photo-1592150621744' }),
    images: z.array(z.string()).default([]),
    stock: z.number().int().min(0).default(0).openapi({ example: 50 }),
    co2SavedKg: z.number().min(0).nullable().optional().openapi({ example: 0.5 }),
    discountType: discountTypeSchema.optional(),
    discountValue: z.number().int().min(0).optional(),
    discountStartDate: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: '2026-11-01T00:00:00.000Z' }),
    discountEndDate: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: '2026-11-30T23:59:59.000Z' }),
    allowCoinRedemption: z.boolean().optional(),
    maxCoinRedemptionPercent: z.number().int().min(0).max(100).optional(),
    isActive: z.boolean().optional(),
  })
  .openapi('CreateSellerProductBody');

export const updateSellerProductBodySchema = createSellerProductBodySchema
  .partial()
  .openapi('UpdateSellerProductBody');

export const sellerProductQuerySchema = z.object({
  category: productCategorySchema.optional().openapi({ param: { name: 'category', in: 'query' } }),
  status: z
    .enum(['all', 'active', 'inactive'])
    .default('all')
    .openapi({ param: { name: 'status', in: 'query' } }),
  q: z
    .string()
    .optional()
    .openapi({ param: { name: 'q', in: 'query' } }),
  cursor: z
    .string()
    .optional()
    .openapi({ param: { name: 'cursor', in: 'query' } }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .default(20)
    .openapi({ param: { name: 'limit', in: 'query' } }),
});

export const sellerOrderItemSchema = z
  .object({
    id: z.number().int().openapi({ example: 1 }),
    productId: z.number().int().openapi({ example: 12 }),
    productName: z.string().openapi({ example: 'Bamboo Toothbrush' }),
    unitPaise: moneySchema,
    quantity: z.number().int().openapi({ example: 2 }),
    totalPaise: moneySchema,
    status: orderStatusSchema,
  })
  .openapi('SellerOrderItem');

export const sellerOrderSchema = z
  .object({
    id: z.number().int().openapi({ example: 101 }),
    orderNumber: z.string().openapi({ example: 'ECO-2026-00042' }),
    createdAt: z.string().openapi({ example: '2026-11-01T10:00:00.000Z' }),
    status: orderStatusSchema,
    customer: z.object({
      id: z.number().int().openapi({ example: 4 }),
      name: z.string().openapi({ example: 'Priya Sharma' }),
      email: z.string().nullable().openapi({ example: 'priya@example.com' }),
    }),
    address: nullable(addressSchema),
    items: z.array(sellerOrderItemSchema),
    sellerSubtotalPaise: moneySchema,
    sellerCoinsSpent: z.number().int().openapi({ example: 100 }),
    sellerDiscountPaise: moneySchema,
    sellerTotalPaise: moneySchema,
  })
  .openapi('SellerOrder');

export const sellerOrderQuerySchema = z.object({
  status: orderStatusSchema.optional().openapi({ param: { name: 'status', in: 'query' } }),
  onlyRedemptions: z.coerce
    .boolean()
    .optional()
    .openapi({ param: { name: 'onlyRedemptions', in: 'query' } }),
  cursor: z
    .string()
    .optional()
    .openapi({ param: { name: 'cursor', in: 'query' } }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .default(20)
    .openapi({ param: { name: 'limit', in: 'query' } }),
});

export const updateSellerOrderStatusBodySchema = z
  .object({
    status: orderStatusSchema,
  })
  .openapi('UpdateSellerOrderStatusBody');

export const sellerAnalyticsSchema = z
  .object({
    totalSalesVolumePaise: moneySchema,
    cashRevenuePaise: moneySchema,
    coinsRedeemedDiscountPaise: moneySchema,
    totalCoinsRedeemed: z.number().int().openapi({ example: 1250 }),
    totalOrdersCount: z.number().int().openapi({ example: 45 }),
    totalUnitsSoldCount: z.number().int().openapi({ example: 88 }),
    activeProductsCount: z.number().int().openapi({ example: 12 }),
    topProducts: z.array(
      z.object({
        productId: z.number().int().openapi({ example: 12 }),
        productName: z.string().openapi({ example: 'Bamboo Toothbrush' }),
        unitsSold: z.number().int().openapi({ example: 34 }),
        revenuePaise: moneySchema,
      }),
    ),
    monthlySales: z.array(
      z.object({
        month: z.string().openapi({ example: '2026-10' }),
        salesPaise: moneySchema,
        cashPaise: moneySchema,
        coinsSpent: z.number().int().openapi({ example: 400 }),
        ordersCount: z.number().int().openapi({ example: 18 }),
      }),
    ),
  })
  .openapi('SellerAnalytics');
