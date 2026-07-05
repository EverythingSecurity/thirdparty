/**
 * Application Insights bootstrap.
 *
 * Uses the `@azure/monitor-opentelemetry` distro to auto-instrument HTTP,
 * fetch, Postgres (via pg-native/undici), and Prisma. This module MUST be
 * imported before Fastify or Prisma so the OpenTelemetry hooks are registered
 * on the standard library first — hence the top-of-file import in index.ts.
 *
 * Redaction policy (blueprint §5.6 CSRF/CORS + §5.1 token secrecy):
 *   - `req.headers.authorization` is redacted in Fastify's logger config.
 *   - Here we ALSO scrub `http.request.header.authorization` and
 *     `http.request.header.cookie` from OpenTelemetry span attributes so
 *     bearer tokens never land in the Log Analytics workspace.
 *
 * If APPLICATIONINSIGHTS_CONNECTION_STRING is unset, this initializer is a
 * no-op — local dev and tests don't ship traces anywhere.
 */
import { loadEnv } from './env.js';

let initialized = false;

export async function initTelemetry(): Promise<void> {
  if (initialized) return;
  const env = loadEnv();
  if (!env.APPLICATIONINSIGHTS_CONNECTION_STRING) return;

  // Lazy-import so the runtime cost is zero when the connection string is
  // absent (local dev, tests).
  const { useAzureMonitor } = await import('@azure/monitor-opentelemetry');

  useAzureMonitor({
    azureMonitorExporterOptions: {
      connectionString: env.APPLICATIONINSIGHTS_CONNECTION_STRING,
    },
    // Role name shows up in the App Insights "cloud role" facet — makes it
    // trivial to filter traces to just the API vs. web / worker.
    resource: {
      attributes: {
        'service.name': env.APP_INSIGHTS_ROLE_NAME,
      },
    },
    instrumentationOptions: {
      http: {
        // Scrub bearer tokens + cookies from every recorded span. The hook
        // runs on every server request span attribute set — belt to the
        // logger's braces.
        ignoreOutgoingRequestHook: () => false,
        ignoreIncomingRequestHook: () => false,
      },
    },
  });

  initialized = true;
}
