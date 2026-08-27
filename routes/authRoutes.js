import { Router } from 'express';
import {
  signup,
  login,
  walletLogin,
  walletStatus,
  getMe,
  changePassword,
  verifyReferralCode,
  forgotPassword,
  resetPassword,
} from '../controllers/authController.js';
import { userAuthMiddleware } from '../middleware/auth.js';

const router = Router();

router.post('/signup', signup);
router.post('/login', login);
router.get('/wallet-status', walletStatus);
router.post('/wallet-login', walletLogin);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);
router.get('/verify-referral', verifyReferralCode);
router.post('/verify-referral', verifyReferralCode);
router.get('/me', userAuthMiddleware, getMe);
router.post('/change-password', userAuthMiddleware, changePassword);

export default router;
