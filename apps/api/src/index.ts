// Telemetry MUST init before Fastify / Prisma so OpenTelemetry hooks
// register on the standard library first (blueprint §6.6).
import { initTelemetry } from './telemetry.js';
await initTelemetry();

import { buildServer } from './server.js';
import { loadEnv } from './env.js';
import { closePrisma } from './db.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await buildServer();

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, 'shutdown_start');
    try {
      await app.close();
      await closePrisma();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'shutdown_failed');
      process.exit(1);
    }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await app.listen({ host: env.API_HOST, port: env.API_PORT });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[api] fatal boot error', err);
  process.exit(1);
});
