import { Router } from 'express';
import {
  getStats, getUsers, getUserDetail, creditDebit, toggleActivation,
  loginAsUser, changeUserPassword,
  updateLevelBonus, updateRewardTier, updateSetting,
  getLevelBonusRates, getRewardTiers,
} from '../controllers/adminController.js';
import {
  getPayoutPreview, triggerPayout, getPayoutRuns,
  getDailyPayoutSummary, getTradeHistory, getDailyTradeSummary,
} from '../controllers/adminPayoutController.js';
import { getBusinessReport } from '../controllers/adminReportController.js';
import { adminAuthMiddleware } from '../middleware/auth.js';

const router = Router();

router.get('/stats', adminAuthMiddleware, getStats);
router.get('/users', adminAuthMiddleware, getUsers);
router.get('/users/:id', adminAuthMiddleware, getUserDetail);
router.post('/login-as-user', adminAuthMiddleware, loginAsUser);
router.post('/change-password', adminAuthMiddleware, changeUserPassword);
router.get('/level-bonus-rates', adminAuthMiddleware, getLevelBonusRates);
router.get('/reward-tiers', adminAuthMiddleware, getRewardTiers);
router.post('/credit-debit', adminAuthMiddleware, creditDebit);
router.post('/toggle-activation', adminAuthMiddleware, toggleActivation);
router.post('/update-level-bonus', adminAuthMiddleware, updateLevelBonus);
router.post('/update-reward-tier', adminAuthMiddleware, updateRewardTier);
router.post('/update-setting', adminAuthMiddleware, updateSetting);

router.get('/payout/preview', adminAuthMiddleware, getPayoutPreview);
router.post('/payout/run', adminAuthMiddleware, triggerPayout);
router.get('/payout/runs', adminAuthMiddleware, getPayoutRuns);
router.get('/payout/daily', adminAuthMiddleware, getDailyPayoutSummary);
router.get('/trades/history', adminAuthMiddleware, getTradeHistory);
router.get('/trades/daily', adminAuthMiddleware, getDailyTradeSummary);
router.get('/reports/business', adminAuthMiddleware, getBusinessReport);

export default router;
