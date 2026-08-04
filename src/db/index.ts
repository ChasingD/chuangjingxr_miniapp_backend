// src/db/index.ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema/orders';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL 未设置，请检查 .env');
}

const pool = new Pool({ connectionString: databaseUrl, max: 10 });

export const db = drizzle(pool, { schema });

export async function initDB() {
  try {
    await pool.query('SELECT 1');
    console.log('[DB] PostgreSQL 连接成功');
  } catch (e) {
    console.error('[DB] PostgreSQL 连接失败:', (e as Error).message);
    throw e;
  }
}

export async function closeDB() {
  await pool.end();
}
