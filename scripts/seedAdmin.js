import dotenv from 'dotenv';
dotenv.config();

import mysql from 'mysql2/promise';

async function seedAdmin() {
  const email = process.env.ADMIN_EMAIL;
  const username = process.env.ADMIN_USERNAME || 'admin';

  if (!email) {
    console.log('ADMIN_EMAIL not set in .env — skip admin seed');
    return;
  }

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'xit_token',
  });

  const [existing] = await connection.query('SELECT id FROM admins WHERE email = ?', [email.toLowerCase()]);
  if (existing.length === 0) {
    await connection.query('INSERT INTO admins (username, email) VALUES (?, ?)', [username, email.toLowerCase()]);
    console.log(`Admin seeded: ${email}`);
  } else {
    console.log(`Admin already exists: ${email}`);
  }

  await connection.end();
}

seedAdmin().catch((err) => {
  console.error('Admin seed failed:', err.message);
  process.exit(1);
});
