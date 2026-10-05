#!/usr/bin/env node
// src/db/migrate.js — applies src/db/schema.sql then ordered migrations in
// src/db/migrations/*.sql, tracking applied migrations in schema_migrations.
// Usage: npm run db:migrate
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

const dir = dirname(fileURLToPath(import.meta.url));

async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function applyOnce(name, sql) {
  const { rows } = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
  if (rows.length) {
    console.log(`[db] ${name} — already applied, skipping`);
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    await client.query('COMMIT');
    console.log(`[db] ${name} — applied`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

try {
  await ensureMigrationsTable();
  // Base schema is idempotent (CREATE TABLE IF NOT EXISTS), tracked as 000.
  await applyOnce('000_base_schema', readFileSync(join(dir, 'schema.sql'), 'utf8'));

  const migDir = join(dir, 'migrations');
  let files = [];
  try {
    files = readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
  } catch {
    files = [];
  }
  for (const f of files) {
    const name = f.replace(/\.sql$/, '');
    await applyOnce(name, readFileSync(join(migDir, f), 'utf8'));
  }
  console.log('[db] migrations complete');
} catch (err) {
  console.error('[db] migration failed:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
