import { fail } from '@common/interceptors/response-envelope.ts';
import { OpenAPIHono } from '@hono/zod-openapi';

/**
 * Every module router is built here, never with `new OpenAPIHono()` directly.
 *
 * The `defaultHook` is the reason: without it a zod validation failure returns
 * zod-openapi's own error shape, which is not the envelope, so a client's
 * `readEnvelope()` throws on the one response it most needs to read. This
 * routes validation failures through `fail()` like every other error.
 */
export function createModule() {
  return new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        return fail(c, 'GEN_400', 'Request validation failed.', 400, {
          // Flattened deliberately: a raw zod issue is not JSON-safe, and a
          // client only ever needs the field and what is wrong with it.
          issues: result.error.issues.map((i) => ({
            path: i.path.map(String).join('.'),
            message: i.message,
          })),
        });
      }
    },
  });
}
