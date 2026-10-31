import { errorFilter, notFoundFilter } from '@common/filters/error-filter.ts';
import { createModule } from '@common/openapi/factory.ts';
import { env } from '@config/env.ts';
import { authRoutes } from '@modules/auth/auth.routes.ts';
import { eventRoutes } from '@modules/events/events.routes.ts';
import { goalRoutes } from '@modules/goals/goals.routes.ts';
import { healthRoutes } from '@modules/health/health.routes.ts';
import { homeRoutes } from '@modules/home/home.routes.ts';
import { leaderboardRoutes } from '@modules/leaderboard/leaderboard.routes.ts';
import { addressRoutes, marketplaceRoutes } from '@modules/marketplace/marketplace.routes.ts';
import { profileRoutes, publicUserRoutes } from '@modules/profile/profile.routes.ts';
import {
  carbonRoutes,
  notificationRoutes,
  referenceRoutes,
  uploadRoutes,
} from '@modules/reference/reference.routes.ts';
import { trackRoutes } from '@modules/track/track.routes.ts';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';

export const app = createModule();

// Global middleware chain (PRD §9.2: request-id · logging · headers · cors).
app.use('*', requestId());
app.use('*', logger());
app.use('*', secureHeaders());
app.use('/api/*', cors({ origin: env.APP_ORIGIN, credentials: true }));

// Route mounting. One mount per module (PRD-v2 §8).
app.route('/api/v1/health', healthRoutes);
app.route('/api/v1/auth', authRoutes);
app.route('/api/v1/profile', profileRoutes);
app.route('/api/v1/users', publicUserRoutes);
app.route('/api/v1/home', homeRoutes);
app.route('/api/v1/track', trackRoutes);
app.route('/api/v1/goals', goalRoutes);
app.route('/api/v1/leaderboard', leaderboardRoutes);
app.route('/api/v1/marketplace', marketplaceRoutes);
app.route('/api/v1/addresses', addressRoutes);
app.route('/api/v1/events', eventRoutes);
app.route('/api/v1/notifications', notificationRoutes);
app.route('/api/v1/uploads', uploadRoutes);
app.route('/api/v1/carbon', carbonRoutes);
app.route('/api/v1', referenceRoutes);

/**
 * The generated contract (PRD-v2 §2.3). `openapi.json` is committed from this
 * document, both client repos generate their types from the committed file, and
 * Prism mocks it on :4010 — so neither client ever waits on this server.
 */
app.doc31('/openapi.json', {
  openapi: '3.1.0',
  info: {
    title: 'EcoLife API',
    version: '0.1.0',
    description:
      'Carbon footprint tracker. Every response uses the envelope ' +
      '`{ status, data, error }`. Clients branch on `error.code`, never on `error.message`.',
  },
  servers: [
    { url: 'http://localhost:4000/api/v1', description: 'local server' },
    {
      url: 'http://localhost:4010/api/v1',
      description: 'Prism mock (examples from this document)',
    },
  ],
  tags: [
    { name: 'health', description: 'Liveness and readiness' },
    { name: 'auth', description: 'Registration, login, tokens, email verification' },
    { name: 'profile', description: 'Onboarding (the 15 questions) and own profile' },
    { name: 'home', description: 'The Home screen, in one request' },
    { name: 'track', description: 'The 5 daily questions and footprint history' },
    { name: 'goals', description: 'Reduction goals' },
    { name: 'leaderboard', description: 'Points ranking' },
    { name: 'marketplace', description: 'Products, cart, coin-discounted orders' },
    { name: 'events', description: 'Events, QR passes, host check-in' },
    { name: 'carbon', description: 'Public methodology and factor table' },
    { name: 'reference', description: 'Cities and regions' },
  ],
});

/**
 * Browsable API reference at /docs, rendered from the same document
 * `/openapi.json` serves — so it can never describe an endpoint that does not
 * exist.
 *
 * NOT REGISTERED IN PRODUCTION. The renderer is a third-party bundle, and
 * serving it from this origin would put a CDN inside our own trust boundary:
 * a compromised bundle would run with access to anything same-origin. A
 * developer convenience is not worth that, so production has no /docs route at
 * all — `docs/api-reference.md` and `/openapi.json` cover the same need
 * without executing anyone else's code.
 *
 * Where it IS registered, the script is pinned by version AND by SRI hash, so
 * the browser refuses a bundle that does not match byte-for-byte. Regenerate
 * the hash if the version changes:
 *   curl -sL <url> | openssl dgst -sha384 -binary | openssl base64 -A
 */
if (env.NODE_ENV !== 'production') {
  app.get('/docs', (c) =>
    c.html(`<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>EcoLife API reference</title>
      <style>
        body { margin: 0; background: #0a1410; }
      </style>
    </head>
    <body>
      <script
        id="api-reference"
        data-url="/openapi.json"
        data-configuration='{"theme":"alternate","hideDownloadButton":false,"defaultHttpClient":{"targetKey":"shell","clientKey":"curl"}}'
      ></script>
      <script
        src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.25.123/dist/browser/standalone.min.js"
        integrity="sha384-ho/Mm/DEWjFqK/vckEklpeWeJkCvvKYCIZsGHS5p3EmnSoi7OWmAAtGP4U7v3bC5"
        crossorigin="anonymous"
      ></script>
    </body>
  </html>`),
  );
}

app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
  description: 'Access token from POST /auth/login. 15 minute lifetime; refresh to rotate.',
});

app.notFound(notFoundFilter);
app.onError(errorFilter);
