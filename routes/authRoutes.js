import { Router } from 'express';
import { signup, login, getMe, changePassword, verifyReferralCode } from '../controllers/authController.js';
import { userAuthMiddleware } from '../middleware/auth.js';

const router = Router();

router.post('/signup', signup);
router.post('/login', login);
router.get('/verify-referral', verifyReferralCode);
router.post('/verify-referral', verifyReferralCode);
router.get('/me', userAuthMiddleware, getMe);
router.post('/change-password', userAuthMiddleware, changePassword);

export default router;
