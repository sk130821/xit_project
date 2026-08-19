import { Router } from 'express';
import { createInvestment, claimRoi, listInvestments, sellTokens } from '../controllers/investmentController.js';
import { userAuthMiddleware } from '../middleware/auth.js';

const router = Router();

router.post('/create', userAuthMiddleware, createInvestment);
router.post('/claim-roi', userAuthMiddleware, claimRoi);
router.get('/list', userAuthMiddleware, listInvestments);
router.post('/sell', userAuthMiddleware, sellTokens);

export default router;
