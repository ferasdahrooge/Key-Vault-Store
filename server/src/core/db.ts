import { PrismaClient } from '@prisma/client';

// Shared Prisma client type used across services and routes.
export type Db = PrismaClient;

// Creates the Prisma client bound to the decrypted database URL.
export function createDb(databaseUrl: string): Db {
  return new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}
