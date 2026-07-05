/**
 * Server factory — exposed separately from `index.ts` so tests can build the
 * app without binding a port. `index.ts` is only the entrypoint.
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import multipart from '@fastify/multipart';
import { loadEnv } from './env.js';
import authPlugin from './plugins/auth.js';
import errorPlugin from './plugins/error.js';
import healthRoutes from './routes/health.js';
import meRoutes from './routes/me.js';
import vendorRoutes from './routes/vendor.js';
import aiRoutes from './routes/ai.js';
import riskRoutes from './routes/risk.js';

export async function buildServer() {
  const env = loadEnv();

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: {
        // Never log the raw Authorization header — it may contain vendor
        // invite tokens which we treat as bearer secrets (blueprint §5.1).
        paths: ['req.headers.authorization', 'req.headers.cookie'],
        censor: '[redacted]',
      },
    },
    disableRequestLogging: false,
    bodyLimit: 1024 * 1024, // 1MB; evidence uploads take a different path (SAS direct upload).
    trustProxy: env.NODE_ENV === 'production',
  });

  await app.register(sensible);
  await app.register(cors, {
    origin: env.CORS_ORIGINS.length > 0 ? env.CORS_ORIGINS : false,
    credentials: true,
  });

  // Evidence uploads are streamed via multipart. The `fileSize` limit is our
  // primary defense against oversized uploads (belt is checked in storage).
  await app.register(multipart, {
    limits: {
      fileSize: env.EVIDENCE_MAX_BYTES,
      files: 1,
      fields: 5,
    },
  });

  await app.register(errorPlugin);
  await app.register(authPlugin);

  await app.register(healthRoutes);
  await app.register(meRoutes);
  await app.register(vendorRoutes);
  await app.register(aiRoutes);
  await app.register(riskRoutes);

  return app;
}
