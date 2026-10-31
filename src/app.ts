import { errorFilter, notFoundFilter } from '@common/filters/error-filter.ts';
import { env } from '@config/env.ts';
import { healthRoutes } from '@modules/health/health.routes.ts';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';

export const app = new Hono();

// Global middleware chain (PRD §9.2: request-id · logging · headers · cors).
app.use('*', requestId());
app.use('*', logger());
app.use('*', secureHeaders());
app.use('/api/*', cors({ origin: env.APP_ORIGIN, credentials: true }));

// Route mounting. One mount per module.
app.route('/api/v1/health', healthRoutes);

app.notFound(notFoundFilter);
app.onError(errorFilter);
