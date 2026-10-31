import { errorResponses, jsonOk, notImplemented, secured } from '@common/openapi/envelope.ts';
import { createModule } from '@common/openapi/factory.ts';
import { cursorQuery, idParam, paginated, slugParam } from '@common/openapi/params.ts';
import { createRoute, z } from '@hono/zod-openapi';
import {
  addCartItemBodySchema,
  addressBodySchema,
  addressSchema,
  cartQuoteSchema,
  orderSchema,
  placeOrderBodySchema,
  previewBodySchema,
  productQuerySchema,
  productSchema,
} from './marketplace.schema.ts';

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
      501: errorResponses[501],
    },
  }),
  notImplemented,
);

marketplaceRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/products/{slug}',
    tags: ['marketplace'],
    summary: 'Product detail',
    security: secured,
    request: { params: slugParam },
    responses: {
      200: jsonOk(productSchema, 'Product'),
      404: errorResponses[404],
      501: errorResponses[501],
    },
  }),
  notImplemented,
);

marketplaceRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/cart',
    tags: ['marketplace'],
    summary: 'Current cart, priced with zero coins applied',
    security: secured,
    responses: {
      200: jsonOk(cartQuoteSchema, 'Cart'),
      401: errorResponses[401],
      501: errorResponses[501],
    },
  }),
  notImplemented,
);

marketplaceRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/cart/items',
    tags: ['marketplace'],
    summary: 'Add an item to the cart',
    security: secured,
    request: {
      body: { content: { 'application/json': { schema: addCartItemBodySchema } }, required: true },
    },
    responses: {
      200: jsonOk(cartQuoteSchema, 'Cart'),
      401: errorResponses[401],
      404: errorResponses[404],
      422: errorResponses[422],
      501: errorResponses[501],
    },
  }),
  notImplemented,
);

marketplaceRoutes.openapi(
  createRoute({
    method: 'patch',
    path: '/cart/items/{id}',
    tags: ['marketplace'],
    summary: 'Change a line quantity (id is the product id)',
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
      501: errorResponses[501],
    },
  }),
  notImplemented,
);

marketplaceRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/cart/items/{id}',
    tags: ['marketplace'],
    summary: 'Remove a line',
    security: secured,
    request: { params: idParam },
    responses: {
      200: jsonOk(cartQuoteSchema, 'Cart'),
      401: errorResponses[401],
      501: errorResponses[501],
    },
  }),
  notImplemented,
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
    security: secured,
    request: {
      body: { content: { 'application/json': { schema: previewBodySchema } }, required: true },
    },
    responses: {
      200: jsonOk(cartQuoteSchema, 'Quote'),
      401: errorResponses[401],
      422: errorResponses[422],
      501: errorResponses[501],
    },
  }),
  notImplemented,
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
      'rather than charging twice.',
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
      501: errorResponses[501],
    },
  }),
  notImplemented,
);

marketplaceRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/orders',
    tags: ['marketplace'],
    summary: 'Own orders',
    security: secured,
    request: { query: cursorQuery },
    responses: {
      200: jsonOk(paginated(orderSchema), 'Orders'),
      401: errorResponses[401],
      501: errorResponses[501],
    },
  }),
  notImplemented,
);

marketplaceRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/orders/{id}',
    tags: ['marketplace'],
    summary: 'Order detail',
    security: secured,
    request: { params: idParam },
    responses: {
      200: jsonOk(orderSchema, 'Order'),
      401: errorResponses[401],
      404: errorResponses[404],
      501: errorResponses[501],
    },
  }),
  notImplemented,
);

export const addressRoutes = createModule();

addressRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['marketplace'],
    summary: 'Own delivery addresses',
    security: secured,
    responses: {
      200: jsonOk(z.object({ items: z.array(addressSchema) }), 'Addresses'),
      401: errorResponses[401],
      501: errorResponses[501],
    },
  }),
  notImplemented,
);

addressRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/',
    tags: ['marketplace'],
    summary: 'Add an address',
    security: secured,
    request: {
      body: { content: { 'application/json': { schema: addressBodySchema } }, required: true },
    },
    responses: {
      201: jsonOk(addressSchema, 'Created'),
      400: errorResponses[400],
      401: errorResponses[401],
      501: errorResponses[501],
    },
  }),
  notImplemented,
);

addressRoutes.openapi(
  createRoute({
    method: 'patch',
    path: '/{id}',
    tags: ['marketplace'],
    summary: 'Edit an address',
    security: secured,
    request: {
      params: idParam,
      body: { content: { 'application/json': { schema: addressBodySchema.partial() } } },
    },
    responses: {
      200: jsonOk(addressSchema, 'Updated'),
      401: errorResponses[401],
      404: errorResponses[404],
      501: errorResponses[501],
    },
  }),
  notImplemented,
);

addressRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/{id}',
    tags: ['marketplace'],
    summary: 'Delete an address',
    security: secured,
    request: { params: idParam },
    responses: {
      200: jsonOk(z.object({ deleted: z.literal(true) }), 'Deleted'),
      401: errorResponses[401],
      404: errorResponses[404],
      501: errorResponses[501],
    },
  }),
  notImplemented,
);
