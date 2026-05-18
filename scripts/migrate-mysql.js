// scripts/migrate-mysql.js — Run once to set up the wa_auth table in Aiven MySQL
// Usage: node scripts/migrate-mysql.js

require('dotenv').config();
const mysql = require('mysql2/promise');

async function migrate() {
  console.log('Connecting to Aiven MySQL...');
  const conn = await mysql.createConnection({
    host:     process.env.DB_HOST,
    port:     parseInt(process.env.DB_PORT || '3306'),
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: false },
  });

  console.log('Running migration...');

  await conn.execute(`
    CREATE TABLE IF NOT EXISTS wa_auth (
      bot      VARCHAR(20)   NOT NULL,
      key_id   VARCHAR(512)  NOT NULL,
      data     LONGTEXT      NOT NULL,
      updated_at TIMESTAMP   DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (bot, key_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  console.log('✅ Table `wa_auth` ready.');
  await conn.end();
}

migrate().catch(err => {
  console.error('❌ Migration failed:', err.message);
  process.exit(1);
});