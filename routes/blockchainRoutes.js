import { Router } from 'express';
import { getConfig, linkWallet, verifyAndBuy, getAdminBlockchainStatus } from '../controllers/blockchainController.js';
import { userAuthMiddleware, adminAuthMiddleware } from '../middleware/auth.js';

const router = Router();

router.get('/config', getConfig);
router.get('/admin-status', adminAuthMiddleware, getAdminBlockchainStatus);
router.post('/link-wallet', userAuthMiddleware, linkWallet);
router.post('/verify-buy', userAuthMiddleware, verifyAndBuy);

export default router;
