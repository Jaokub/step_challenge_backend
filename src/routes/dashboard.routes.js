import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth.js';
import {
  getPersonalDashboard,
  getAdminDashboard,
  getStats,
} from '../controllers/dashboard.controller.js';

const router = Router();

// All routes require authentication
router.use(authenticate);

/**
 * @route   GET /api/dashboard/personal
 * @desc    Get personal dashboard data for the current user
 * @access  Private
 */
router.get('/personal', getPersonalDashboard);

/**
 * @route   GET /api/dashboard/admin
 * @desc    Get admin dashboard data
 * @access  Private/Admin
 */
router.get('/admin', requireRole('ADMIN'), getAdminDashboard);

/**
 * @route   GET /api/dashboard/stats
 * @desc    Get general statistics
 * @access  Private
 */
router.get('/stats', getStats);

export default router;
