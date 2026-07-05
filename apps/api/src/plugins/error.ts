/**
 * Global error handler — maps `AppError` subclasses to their status codes and
 * emits the standard envelope from blueprint §4. Unknown errors are logged
 * with full detail server-side but serialized as an opaque 500 to the client
 * (never leak stack traces or ORM internals).
 */
import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyError } from 'fastify';
import { AppError } from '@vsa/shared';
import { ZodError } from 'zod';

const errorPlugin: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((err: FastifyError, req, reply) => {
    // Known application errors — safe to send envelope as-is.
    if (err instanceof AppError) {
      req.log.info({ code: err.code, statusCode: err.statusCode }, 'app_error');
      return reply.status(err.statusCode).send(err.toEnvelope());
    }

    // Zod validation errors from request body/query parsing.
    if (err instanceof ZodError) {
      const fields = err.issues.reduce<Record<string, string>>((acc, iss) => {
        const key = iss.path.join('.') || '_';
        acc[key] = iss.message;
        return acc;
      }, {});
      return reply.status(400).send({
        error: {
          code: 'validation_error',
          message: 'Invalid request',
          fields,
        },
      });
    }

    // Fastify's own validation (JSON schema, etc.) — 400.
    if (err.validation) {
      return reply.status(400).send({
        error: {
          code: 'validation_error',
          message: err.message,
        },
      });
    }

    // Anything else — log + opaque 500.
    req.log.error({ err }, 'unhandled_error');
    return reply.status(500).send({
      error: {
        code: 'internal_error',
        message: 'An unexpected error occurred',
      },
    });
  });

  // 404 handler — same envelope shape.
  app.setNotFoundHandler((_req, reply) => {
    return reply.status(404).send({
      error: {
        code: 'not_found',
        message: 'Route not found',
      },
    });
  });
};

export default fp(errorPlugin, { name: 'error' });
