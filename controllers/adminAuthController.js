import { pool } from '../db.js';
import { generateAdminToken } from '../middleware/auth.js';

export async function adminLogin(req, res) {
  try {
    const { email, password } = req.body;

    const adminEmail = process.env.ADMIN_EMAIL;
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (!adminEmail || !adminPassword) {
      return res.status(500).json({ error: 'Admin credentials not configured in server .env' });
    }

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    if (email.toLowerCase() !== adminEmail.toLowerCase() || password !== adminPassword) {
      return res.status(401).json({ error: 'Invalid admin email or password' });
    }

    const [admins] = await pool.query('SELECT * FROM admins WHERE email = ?', [adminEmail.toLowerCase()]);

    let admin;
    if (admins.length === 0) {
      const username = process.env.ADMIN_USERNAME || 'admin';
      const [result] = await pool.query(
        'INSERT INTO admins (username, email) VALUES (?, ?)',
        [username, adminEmail.toLowerCase()]
      );
      admin = { id: result.insertId, username, email: adminEmail.toLowerCase() };
    } else {
      admin = admins[0];
    }

    const token = generateAdminToken(admin);

    res.json({
      token,
      admin: {
        id: admin.id,
        username: admin.username,
        email: admin.email,
      },
    });
  } catch (err) {
    console.error('Admin login error:', err);
    res.status(500).json({ error: 'Server error during admin login' });
  }
}

export async function adminMe(req, res) {
  try {
    const [admins] = await pool.query('SELECT id, username, email, created_at FROM admins WHERE id = ?', [req.adminId]);
    if (admins.length === 0) {
      return res.status(404).json({ error: 'Admin not found' });
    }

    res.json(admins[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
}
