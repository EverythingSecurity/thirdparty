import type { FastifyPluginAsync } from 'fastify';
import { getPrisma } from '../db.js';

const healthRoutes: FastifyPluginAsync = async (app) => {
  // Liveness — no dependencies checked, just "process is up".
  app.get('/health', async () => ({ status: 'ok' }));

  // Readiness — includes DB connectivity check. Suitable for orchestrator probes.
  app.get('/ready', async (_req, reply) => {
    try {
      await getPrisma().$queryRaw`SELECT 1`;
      return { status: 'ready' };
    } catch (err) {
      return reply.status(503).send({
        error: { code: 'not_ready', message: 'Database unreachable' },
      });
    }
  });
};

export default healthRoutes;
