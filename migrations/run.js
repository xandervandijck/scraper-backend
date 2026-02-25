#!/usr/bin/env node
/**
 * Migration runner — executes 001_initial.sql against DATABASE_URL.
 * Usage: node migrations/run.js
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function run() {
  for (const file of ['001_initial.sql', '002_use_case.sql']) {
    const sql = readFileSync(path.join(__dirname, file), 'utf-8');
    console.log(`Running migration ${file}...`);
    await pool.query(sql);
    console.log(`✓ ${file} complete`);
  }
  await pool.end();
}

run().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
