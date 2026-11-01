import { requireAdmin, requireUser } from '@common/guards/auth.guard.ts';
import { ok } from '@common/interceptors/response-envelope.ts';
import { errorResponses, jsonOk, secured } from '@common/openapi/envelope.ts';
import { createModule } from '@common/openapi/factory.ts';
import { idParam, paginated } from '@common/openapi/params.ts';
import { createRoute } from '@hono/zod-openapi';
import {
  createPayoutBodySchema,
  listLedgerQuerySchema,
  listSettlementsQuerySchema,
  orderSettlementSchema,
  revenueAnalyticsSchema,
  sellerCommissionOverrideBodySchema,
  sellerCommissionOverrideSchema,
  sellerPayoutSchema,
  settlementLedgerEntrySchema,
  systemSettingsSchema,
  updateSystemSettingsBodySchema,
} from './revenue.schema.ts';
import * as service from './revenue.service.ts';

/**
 * Economy & Monetization Settings (admin only, PRD-v2 Part 7, Requirements 25 & 26).
 * Mounted at `/api/v1/admin/settings`.
 */
export const adminSettingsRoutes = createModule();

adminSettingsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['admin-revenue'],
    summary: 'Get global economy and commission settings',
    middleware: [requireUser, requireAdmin] as const,
    security: secured,
    responses: {
      200: jsonOk(systemSettingsSchema, 'Global system settings'),
      401: errorResponses[401],
      403: errorResponses[403],
    },
  }),
  async (c) => ok(c, await service.getSettings(), 200),
);

adminSettingsRoutes.openapi(
  createRoute({
    method: 'patch',
    path: '/',
    tags: ['admin-revenue'],
    summary: 'Update global economy and commission settings',
    description:
      'Configures sales commission %, coin fee %, coin-to-rupee rate, and max coin redemption discount %.',
    middleware: [requireUser, requireAdmin] as const,
    security: secured,
    request: {
      body: { content: { 'application/json': { schema: updateSystemSettingsBodySchema } } },
    },
    responses: {
      200: jsonOk(systemSettingsSchema, 'Updated system settings'),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
    },
  }),
  async (c) => ok(c, await service.updateSettings(c.req.valid('json'), c.get('user').id), 200),
);

adminSettingsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/sellers/{id}/commission',
    tags: ['admin-revenue'],
    summary: 'Get seller commission override',
    middleware: [requireUser, requireAdmin] as const,
    security: secured,
    request: { params: idParam },
    responses: {
      200: jsonOk(sellerCommissionOverrideSchema, 'Seller commission override'),
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) => ok(c, await service.getSellerOverride(c.req.valid('param').id), 200),
);

adminSettingsRoutes.openapi(
  createRoute({
    method: 'put',
    path: '/sellers/{id}/commission',
    tags: ['admin-revenue'],
    summary: 'Set or clear seller commission override',
    description: 'Set `commissionRateBps: null` to revert to global platform default.',
    middleware: [requireUser, requireAdmin] as const,
    security: secured,
    request: {
      params: idParam,
      body: { content: { 'application/json': { schema: sellerCommissionOverrideBodySchema } } },
    },
    responses: {
      200: jsonOk(sellerCommissionOverrideSchema, 'Updated seller commission override'),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) =>
    ok(
      c,
      await service.setSellerOverride(
        c.req.valid('param').id,
        c.req.valid('json').commissionRateBps,
        c.get('user').id,
      ),
      200,
    ),
);

/**
 * Platform Revenue, Settlements & Ledger (admin only, PRD-v2 Part 7, Requirements 27 & 28).
 * Mounted at `/api/v1/admin/revenue`.
 */
export const adminRevenueRoutes = createModule();

adminRevenueRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/analytics',
    tags: ['admin-revenue'],
    summary: 'Platform revenue, GMV, coin liability, and payout summary',
    middleware: [requireUser, requireAdmin] as const,
    security: secured,
    responses: {
      200: jsonOk(revenueAnalyticsSchema, 'Revenue analytics summary'),
      401: errorResponses[401],
      403: errorResponses[403],
    },
  }),
  async (c) => ok(c, await service.analytics(), 200),
);

adminRevenueRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/settlements',
    tags: ['admin-revenue'],
    summary: 'List order settlements',
    description: 'Line-item breakdown of sales, coin subsidies, platform commissions, and seller payouts.',
    middleware: [requireUser, requireAdmin] as const,
    security: secured,
    request: { query: listSettlementsQuerySchema },
    responses: {
      200: jsonOk(paginated(orderSettlementSchema), 'Order settlements'),
      401: errorResponses[401],
      403: errorResponses[403],
    },
  }),
  async (c) => ok(c, await service.settlements(c.req.valid('query')), 200),
);

adminRevenueRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/payouts',
    tags: ['admin-revenue'],
    summary: 'List seller payout records',
    middleware: [requireUser, requireAdmin] as const,
    security: secured,
    request: {
      query: listSettlementsQuerySchema.pick({ sellerOrgId: true, cursor: true, limit: true }),
    },
    responses: {
      200: jsonOk(paginated(sellerPayoutSchema), 'Seller payouts'),
      401: errorResponses[401],
      403: errorResponses[403],
    },
  }),
  async (c) => ok(c, await service.payouts(c.req.valid('query')), 200),
);

adminRevenueRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/payouts',
    tags: ['admin-revenue'],
    summary: 'Disburse pending settlements to seller',
    description: 'Creates a payout batch and marks associated settlements as settled.',
    middleware: [requireUser, requireAdmin] as const,
    security: secured,
    request: {
      body: { content: { 'application/json': { schema: createPayoutBodySchema } } },
    },
    responses: {
      201: jsonOk(sellerPayoutSchema, 'Payout disbursed'),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
    },
  }),
  async (c) => ok(c, await service.createPayout(c.req.valid('json'), c.get('user').id), 201),
);

adminRevenueRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/ledger',
    tags: ['admin-revenue'],
    summary: 'Immutable transaction ledger journal',
    description: 'Double-entry style audit log for commissions, coin subsidies, fees, and payouts.',
    middleware: [requireUser, requireAdmin] as const,
    security: secured,
    request: { query: listLedgerQuerySchema },
    responses: {
      200: jsonOk(paginated(settlementLedgerEntrySchema), 'Settlement ledger entries'),
      401: errorResponses[401],
      403: errorResponses[403],
    },
  }),
  async (c) => ok(c, await service.ledger(c.req.valid('query')), 200),
);
