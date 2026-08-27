import '../loadEnv.js';
import { pool } from '../db.js';

async function main() {
  const steps = [
    `ALTER TABLE users MODIFY email VARCHAR(255) NULL`,
    `ALTER TABLE users MODIFY password VARCHAR(255) NULL`,
    `ALTER TABLE users ADD UNIQUE INDEX uq_users_wallet_address (wallet_address)`,
  ];
  for (const sql of steps) {
    try {
      await pool.query(sql);
      console.log('OK:', sql.slice(0, 60));
    } catch (err) {
      console.log('SKIP/ERR:', err.message);
    }
  }
  const [cols] = await pool.query(
    `SHOW COLUMNS FROM users WHERE Field IN ('email','password','wallet_address')`
  );
  console.log(cols);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
