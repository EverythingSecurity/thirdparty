/**
 * Environment validation — fail-fast on boot if required config is missing
 * or malformed. Every consumer imports `env` from here rather than reading
 * `process.env` directly, so the typed contract is enforced.
 */
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().url(),

  JWT_ISSUER: z.string().min(1),
  JWT_AUDIENCE: z.string().min(1),
  // HS256 dev secret. In prod, swap to JWKS-based verification against Entra ID.
  JWT_DEV_SECRET: z.string().min(32, 'JWT_DEV_SECRET must be ≥32 chars'),

  // Server-side pepper for HMAC-hashing vendor invite tokens.
  VENDOR_TOKEN_PEPPER: z
    .string()
    .min(32, 'VENDOR_TOKEN_PEPPER must be ≥32 chars for reasonable HMAC entropy'),

  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((o) => o.trim())
        .filter((o) => o.length > 0),
    ),

  // Evidence storage — local filesystem in dev; Azure Blob in Sprint 7.
  EVIDENCE_STORAGE: z.enum(['local', 'azure_blob']).default('local'),
  EVIDENCE_LOCAL_ROOT: z.string().default('./.storage/evidence'),
  EVIDENCE_MAX_BYTES: z.coerce.number().int().positive().default(26_214_400),

  // Azure Application Insights — set by Container Apps env in prod;
  // absent locally so telemetry is a no-op.
  APPLICATIONINSIGHTS_CONNECTION_STRING: z.string().optional(),
  APP_INSIGHTS_ROLE_NAME: z.string().default('vsa-api'),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // Print the first flattened error and exit — never boot with bad config.
    const flat = parsed.error.flatten();
    // eslint-disable-next-line no-console
    console.error('[env] invalid configuration:', flat.fieldErrors);
    throw new Error('Environment validation failed');
  }
  cached = parsed.data;
  return cached;
}
