import { Router } from 'express';
import { buyTokens } from '../controllers/tokenController.js';
import { userAuthMiddleware } from '../middleware/auth.js';

const router = Router();

router.post('/buy', userAuthMiddleware, buyTokens);

export default router;
