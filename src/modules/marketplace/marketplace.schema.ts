import { nullable } from '@common/openapi/envelope.ts';
import { moneySchema } from '@common/openapi/shared-schemas.ts';
import { z } from '@hono/zod-openapi';

/** PRD-v2 §6.5. Coins buy a discount, capped at 20%. All money is integer paise. */

export const productCategorySchema = z
  .enum(['plants', 'household', 'personal_care', 'kitchen', 'stationery'])
  .openapi({ example: 'plants' });

export const productSchema = z
  .object({
    id: z.number().int().openapi({ example: 12 }),
    slug: z.string().openapi({ example: 'tulsi-plant' }),
    name: z.string().openapi({ example: 'Tulsi plant, terracotta pot' }),
    description: z.string().nullable().openapi({ example: 'Grown without synthetic fertiliser.' }),
    category: productCategorySchema,
    pricePaise: moneySchema,
    imageUrl: z.string().nullable().openapi({
      example:
        'https://images.unsplash.com/photo-1592150621744-aca64f48394a?auto=format&fit=crop&w=800&q=80',
    }),
    stock: z.number().int().openapi({ example: 34 }),
    co2SavedKg: z
      .number()
      .nullable()
      .openapi({ example: 21.9, description: 'Why the product exists. Shown on the card.' }),
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
    line2: z.string().nullable().openapi({ example: null }),
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
