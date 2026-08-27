import { Router } from 'express';
import { getConfig, linkWallet, verifyAndBuy, completeBuyFromTx, getAdminBlockchainStatus, getMemberWalletBalance } from '../controllers/blockchainController.js';
import { userAuthMiddleware, adminAuthMiddleware } from '../middleware/auth.js';

const router = Router();

router.get('/config', getConfig);
router.get('/wallet-balance', userAuthMiddleware, getMemberWalletBalance);
router.get('/admin-status', adminAuthMiddleware, getAdminBlockchainStatus);
router.post('/link-wallet', userAuthMiddleware, linkWallet);
router.post('/verify-buy', userAuthMiddleware, verifyAndBuy);
router.post('/complete-buy', userAuthMiddleware, completeBuyFromTx);

export default router;
