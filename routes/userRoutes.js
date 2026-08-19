import { Router } from 'express';
import {
  getNetwork, getTransactions, getLevelBonusRates, getRewardTiers,
  getSettings, getRewardStatus,
} from '../controllers/userController.js';
import { userAuthMiddleware } from '../middleware/auth.js';

const router = Router();

router.get('/network', userAuthMiddleware, getNetwork);
router.get('/transactions', userAuthMiddleware, getTransactions);
router.get('/level-bonus-rates', getLevelBonusRates);
router.get('/reward-tiers', getRewardTiers);
router.get('/reward-status', userAuthMiddleware, getRewardStatus);
router.get('/settings', getSettings);

export default router;
