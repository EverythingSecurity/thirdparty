import { PrismaClient } from '@prisma/client';
import { loadEnv } from './env.js';

let client: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (client) return client;
  const env = loadEnv();
  client = new PrismaClient({
    datasources: { db: { url: env.DATABASE_URL } },
    log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
  return client;
}

export async function closePrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = null;
  }
}
