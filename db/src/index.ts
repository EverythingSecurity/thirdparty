import { PrismaClient } from '@prisma/client';

export * from '@prisma/client';

export function createPrismaClient(opts?: ConstructorParameters<typeof PrismaClient>[0]): PrismaClient {
  return new PrismaClient(opts);
}
