import { ensureSellOrdersTable } from '../services/sellOrderService.js';
import { pool } from '../db.js';

await ensureSellOrdersTable();
const [rows] = await pool.query("SHOW TABLES LIKE 'sell_orders'");
console.log(rows.length ? 'sell_orders table ready' : 'sell_orders missing');
process.exit(0);
