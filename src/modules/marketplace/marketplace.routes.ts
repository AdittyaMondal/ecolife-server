import { requireUser } from '@common/guards/auth.guard.ts';
import { ok } from '@common/interceptors/response-envelope.ts';
import { errorResponses, jsonOk, secured } from '@common/openapi/envelope.ts';
import { createModule } from '@common/openapi/factory.ts';
import { cursorQuery, idParam, paginated, slugParam } from '@common/openapi/params.ts';
import { createRoute, z } from '@hono/zod-openapi';
import {
  addCartItemBodySchema,
  addressBodySchema,
  addressSchema,
  cartQuoteSchema,
  createSellerProductBodySchema,
  orderSchema,
  placeOrderBodySchema,
  previewBodySchema,
  productQuerySchema,
  productSchema,
  sellerAnalyticsSchema,
  sellerOrderQuerySchema,
  sellerOrderSchema,
  sellerProductQuerySchema,
  updateSellerOrderStatusBodySchema,
  updateSellerProductBodySchema,
} from './marketplace.schema.ts';
import * as service from './marketplace.service.ts';

export const marketplaceRoutes = createModule();

marketplaceRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/products',
    tags: ['marketplace'],
    summary: 'Browse eco products',
    security: secured,
    request: { query: productQuerySchema },
    responses: {
      200: jsonOk(paginated(productSchema), 'Products'),
      401: errorResponses[401],
    },
  }),
  async (c) => ok(c, await service.products(c.req.valid('query')), 200),
);

marketplaceRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/products/{slug}',
    tags: ['marketplace'],
    summary: 'Product detail',
    security: secured,
    request: { params: slugParam('tulsi-sapling') },
    responses: {
      200: jsonOk(productSchema, 'Product'),
      404: errorResponses[404],
    },
  }),
  async (c) => ok(c, await service.product(c.req.valid('param').slug), 200),
);

marketplaceRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/cart',
    tags: ['marketplace'],
    summary: 'Current cart, priced with zero coins applied',
    middleware: [requireUser] as const,
    security: secured,
    responses: {
      200: jsonOk(cartQuoteSchema, 'Cart'),
      401: errorResponses[401],
    },
  }),
  async (c) => ok(c, await service.cart(c.get('user').id), 200),
);

marketplaceRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/cart/items',
    tags: ['marketplace'],
    summary: 'Add an item to the cart',
    middleware: [requireUser] as const,
    security: secured,
    request: {
      body: { content: { 'application/json': { schema: addCartItemBodySchema } }, required: true },
    },
    responses: {
      200: jsonOk(cartQuoteSchema, 'Cart'),
      401: errorResponses[401],
      404: errorResponses[404],
      422: errorResponses[422],
    },
  }),
  async (c) => {
    const { productId, quantity } = c.req.valid('json');
    return ok(c, await service.addToCart(c.get('user').id, productId, quantity), 200);
  },
);

marketplaceRoutes.openapi(
  createRoute({
    method: 'patch',
    path: '/cart/items/{id}',
    tags: ['marketplace'],
    summary: 'Change a line quantity (id is the product id)',
    middleware: [requireUser] as const,
    security: secured,
    request: {
      params: idParam,
      body: {
        content: {
          'application/json': {
            schema: z.object({ quantity: z.number().int().min(0).max(20) }),
          },
        },
        required: true,
      },
    },
    responses: {
      200: jsonOk(cartQuoteSchema, 'Cart'),
      401: errorResponses[401],
      404: errorResponses[404],
    },
  }),
  async (c) =>
    ok(
      c,
      await service.setQuantity(
        c.get('user').id,
        c.req.valid('param').id,
        c.req.valid('json').quantity,
      ),
      200,
    ),
);

marketplaceRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/cart/items/{id}',
    tags: ['marketplace'],
    summary: 'Remove a line',
    middleware: [requireUser] as const,
    security: secured,
    request: { params: idParam },
    responses: {
      200: jsonOk(cartQuoteSchema, 'Cart'),
      401: errorResponses[401],
    },
  }),
  async (c) => ok(c, await service.removeFromCart(c.get('user').id, c.req.valid('param').id), 200),
);

marketplaceRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/cart/preview',
    tags: ['marketplace'],
    summary: 'Server-priced quote for a coin offer',
    description:
      'Drives the coin slider. discount = min(offered/10 x 100, 20% of subtotal, wallet). ' +
      'The client never computes the price it pays.',
    middleware: [requireUser] as const,
    security: secured,
    request: {
      body: { content: { 'application/json': { schema: previewBodySchema } }, required: true },
    },
    responses: {
      200: jsonOk(cartQuoteSchema, 'Quote'),
      401: errorResponses[401],
      422: errorResponses[422],
    },
  }),
  async (c) =>
    ok(c, await service.preview(c.get('user').id, c.req.valid('json').offeredCoins), 200),
);

marketplaceRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/orders',
    tags: ['marketplace'],
    summary: 'Place an order',
    description:
      'One transaction: decrement stock, insert the order with price snapshots, debit coins ' +
      'through the ledger. Replaying the same idempotencyKey returns the original order ' +
      'rather than charging twice — and returns it with its `address`, exactly as the ' +
      'first call did.\n\n' +
      'THERE IS NO PAYMENT STEP, and this is the design, not an omission: PRD-v2 §6.5 ' +
      'says "No real-money payment in v2". Coins buy a DISCOUNT (capped at ' +
      'MAX_DISCOUNT_PCT of the subtotal); the remaining `totalPaise` is settled offline ' +
      'and fulfilment is manual. The order therefore goes straight to `placed` with no ' +
      'payment-method field, no gateway redirect and no webhook to wait for. Clients ' +
      'should present it as "order placed, pay on delivery", never as "paid".',
    middleware: [requireUser] as const,
    security: secured,
    request: {
      body: { content: { 'application/json': { schema: placeOrderBodySchema } }, required: true },
    },
    responses: {
      201: jsonOk(orderSchema, 'Order placed'),
      400: errorResponses[400],
      401: errorResponses[401],
      409: errorResponses[409],
      422: errorResponses[422],
      429: errorResponses[429],
    },
  }),
  async (c) => ok(c, await service.placeOrder(c.get('user').id, c.req.valid('json')), 201),
);

marketplaceRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/orders',
    tags: ['marketplace'],
    summary: 'Own orders',
    description:
      'Each row carries its full `address`, so a list does not have to be followed by one ' +
      'GET per order to render a delivery line.',
    middleware: [requireUser] as const,
    security: secured,
    request: { query: cursorQuery },
    responses: {
      200: jsonOk(paginated(orderSchema), 'Orders'),
      401: errorResponses[401],
    },
  }),
  async (c) => {
    const { cursor, limit } = c.req.valid('query');
    return ok(c, await service.orders(c.get('user').id, limit, cursor), 200);
  },
);

marketplaceRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/orders/{id}',
    tags: ['marketplace'],
    summary: 'Order detail',
    middleware: [requireUser] as const,
    security: secured,
    request: { params: idParam },
    responses: {
      200: jsonOk(orderSchema, 'Order'),
      401: errorResponses[401],
      404: errorResponses[404],
    },
  }),
  async (c) => ok(c, await service.order(c.get('user').id, c.req.valid('param').id), 200),
);

export const addressRoutes = createModule();

addressRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['marketplace'],
    summary: 'Own delivery addresses',
    middleware: [requireUser] as const,
    security: secured,
    responses: {
      200: jsonOk(z.object({ items: z.array(addressSchema) }), 'Addresses'),
      401: errorResponses[401],
    },
  }),
  async (c) => ok(c, await service.listAddresses(c.get('user').id), 200),
);

addressRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/',
    tags: ['marketplace'],
    summary: 'Add an address',
    middleware: [requireUser] as const,
    security: secured,
    request: {
      body: { content: { 'application/json': { schema: addressBodySchema } }, required: true },
    },
    responses: {
      201: jsonOk(addressSchema, 'Created'),
      400: errorResponses[400],
      401: errorResponses[401],
    },
  }),
  async (c) => ok(c, await service.createAddress(c.get('user').id, c.req.valid('json')), 201),
);

addressRoutes.openapi(
  createRoute({
    method: 'patch',
    path: '/{id}',
    tags: ['marketplace'],
    summary: 'Edit an address',
    middleware: [requireUser] as const,
    security: secured,
    request: {
      params: idParam,
      body: { content: { 'application/json': { schema: addressBodySchema.partial() } } },
    },
    responses: {
      200: jsonOk(addressSchema, 'Updated'),
      401: errorResponses[401],
      404: errorResponses[404],
    },
  }),
  async (c) =>
    ok(
      c,
      await service.updateAddress(c.get('user').id, c.req.valid('param').id, c.req.valid('json')),
      200,
    ),
);

addressRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/{id}',
    tags: ['marketplace'],
    summary: 'Delete an address',
    middleware: [requireUser] as const,
    security: secured,
    request: { params: idParam },
    responses: {
      200: jsonOk(z.object({ deleted: z.literal(true) }), 'Deleted'),
      401: errorResponses[401],
      404: errorResponses[404],
    },
  }),
  async (c) => ok(c, await service.deleteAddress(c.get('user').id, c.req.valid('param').id), 200),
);

// --- Seller Portal Routes (Part 6) ------------------------------------------

export const sellerRoutes = createModule();

sellerRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/products',
    tags: ['seller'],
    summary: 'List own products',
    middleware: [requireUser] as const,
    security: secured,
    request: { query: sellerProductQuerySchema },
    responses: {
      200: jsonOk(paginated(productSchema), 'Seller products'),
      401: errorResponses[401],
      403: errorResponses[403],
    },
  }),
  async (c) => ok(c, await service.sellerProducts(c.get('user').id, c.req.valid('query')), 200),
);

sellerRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/products',
    tags: ['seller'],
    summary: 'Create a product',
    middleware: [requireUser] as const,
    security: secured,
    request: {
      body: {
        content: { 'application/json': { schema: createSellerProductBodySchema } },
        required: true,
      },
    },
    responses: {
      201: jsonOk(productSchema, 'Product created'),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
    },
  }),
  async (c) => ok(c, await service.createSellerProduct(c.get('user').id, c.req.valid('json')), 201),
);

sellerRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/products/{id}',
    tags: ['seller'],
    summary: 'Get seller product detail',
    middleware: [requireUser] as const,
    security: secured,
    request: { params: idParam },
    responses: {
      200: jsonOk(productSchema, 'Product detail'),
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) => ok(c, await service.sellerProduct(c.get('user').id, c.req.valid('param').id), 200),
);

sellerRoutes.openapi(
  createRoute({
    method: 'patch',
    path: '/products/{id}',
    tags: ['seller'],
    summary: 'Update seller product',
    middleware: [requireUser] as const,
    security: secured,
    request: {
      params: idParam,
      body: {
        content: { 'application/json': { schema: updateSellerProductBodySchema } },
        required: true,
      },
    },
    responses: {
      200: jsonOk(productSchema, 'Product updated'),
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) =>
    ok(
      c,
      await service.updateSellerProduct(
        c.get('user').id,
        c.req.valid('param').id,
        c.req.valid('json'),
      ),
      200,
    ),
);

sellerRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/products/{id}',
    tags: ['seller'],
    summary: 'Delete or deactivate product',
    middleware: [requireUser] as const,
    security: secured,
    request: { params: idParam },
    responses: {
      200: jsonOk(z.object({ deleted: z.literal(true) }), 'Deleted'),
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) =>
    ok(c, await service.deleteSellerProduct(c.get('user').id, c.req.valid('param').id), 200),
);

sellerRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/orders',
    tags: ['seller'],
    summary: 'List orders containing seller items',
    middleware: [requireUser] as const,
    security: secured,
    request: { query: sellerOrderQuerySchema },
    responses: {
      200: jsonOk(paginated(sellerOrderSchema), 'Seller orders'),
      401: errorResponses[401],
      403: errorResponses[403],
    },
  }),
  async (c) => ok(c, await service.sellerOrders(c.get('user').id, c.req.valid('query')), 200),
);

sellerRoutes.openapi(
  createRoute({
    method: 'patch',
    path: '/orders/{id}/status',
    tags: ['seller'],
    summary: 'Update fulfillment status of an order',
    middleware: [requireUser] as const,
    security: secured,
    request: {
      params: idParam,
      body: {
        content: { 'application/json': { schema: updateSellerOrderStatusBodySchema } },
        required: true,
      },
    },
    responses: {
      200: jsonOk(
        z.object({
          success: z.literal(true),
          status: z
            .enum(['placed', 'confirmed', 'shipped', 'delivered', 'cancelled'])
            .openapi({
              example: 'shipped',
              description: "The status this seller's own items now carry.",
            }),
          orderStatus: z
            .enum(['placed', 'confirmed', 'shipped', 'delivered', 'cancelled'])
            .openapi({
              example: 'confirmed',
              description:
                "The whole order, DERIVED from every seller's items: the least advanced live " +
                'item, or cancelled when all items are. On a multi-seller order this will lag ' +
                '`status` until the other sellers catch up.',
            }),
        }),
        'Status updated',
      ),
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
      422: errorResponses[422],
    },
  }),
  async (c) =>
    ok(
      c,
      await service.updateSellerOrderStatus(
        c.get('user').id,
        c.req.valid('param').id,
        c.req.valid('json').status,
      ),
      200,
    ),
);

sellerRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/analytics',
    tags: ['seller'],
    summary: 'Seller sales and earnings reports',
    middleware: [requireUser] as const,
    security: secured,
    responses: {
      200: jsonOk(sellerAnalyticsSchema, 'Seller analytics'),
      401: errorResponses[401],
      403: errorResponses[403],
    },
  }),
  async (c) => ok(c, await service.sellerAnalytics(c.get('user').id), 200),
);
