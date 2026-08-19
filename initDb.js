import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function runSqlFile(connection, filePath) {
  const sql = fs.readFileSync(filePath, 'utf8');
  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('--'));

  for (const statement of statements) {
    try {
      await connection.query(statement);
    } catch (err) {
      if (err.code === 'ER_DUP_FIELDNAME' || err.code === 'ER_TABLE_EXISTS_ERROR') continue;
      throw err;
    }
  }
}

async function initDb() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true,
  });

  console.log('Connected to MySQL. Running schema...');

  const schemaPath = path.join(__dirname, 'schema.sql');
  await connection.query(fs.readFileSync(schemaPath, 'utf8'));
  console.log('Schema applied successfully!');

  const migrationsDir = path.join(__dirname, 'migrations');
  if (fs.existsSync(migrationsDir)) {
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      console.log(`Running migration: ${file}`);
      await runSqlFile(connection, path.join(migrationsDir, file));
    }
    console.log('Migrations applied!');
  }

  await connection.end();
  console.log('Done. You can now start the server with: npm start');
}

initDb().catch((err) => {
  console.error('Failed to initialize database:', err.message);
  process.exit(1);
});
