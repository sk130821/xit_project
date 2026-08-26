import './loadEnv.js';
import express from 'express';
import cors from 'cors';
import authRoutes from './routes/authRoutes.js';
import tokenRoutes from './routes/tokenRoutes.js';
import investmentRoutes from './routes/investmentRoutes.js';
import userRoutes from './routes/userRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import adminAuthRoutes from './routes/adminAuthRoutes.js';
import blockchainRoutes from './routes/blockchainRoutes.js';
import { startAutoRoiCron } from './jobs/autoRoiCron.js';
import { runDailyPayoutCron, debugPayoutCron } from './controllers/cronController.js';

const app = express();
const PORT = process.env.PORT || 5000;

const corsOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.set('trust proxy', 1);
app.use(cors({
  origin(origin, callback) {
    if (!origin || corsOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS blocked: ${origin}`));
    }
  },
  credentials: true,
}));
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'XIT Token API running',
    dbNameEnv: process.env.DB_NAME || null,
    time: new Date().toISOString(),
  });
});

app.get('/api/cron/daily-payout', runDailyPayoutCron);
app.post('/api/cron/daily-payout', runDailyPayoutCron);
app.get('/api/cron/debug-payout', debugPayoutCron);

app.use('/api/auth', authRoutes);
app.use('/api/tokens', tokenRoutes);
app.use('/api/investments', investmentRoutes);
app.use('/api/user', userRoutes);
app.use('/api/admin/auth', adminAuthRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/blockchain', blockchainRoutes);

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`XIT Token server running on port ${PORT}`);
  startAutoRoiCron();
});
