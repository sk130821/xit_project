import { Router } from 'express';
import { adminLogin, adminMe } from '../controllers/adminAuthController.js';
import { adminAuthMiddleware } from '../middleware/auth.js';

const router = Router();

router.post('/login', adminLogin);
router.get('/me', adminAuthMiddleware, adminMe);

export default router;
