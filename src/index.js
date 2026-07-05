import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';

// ─── Global Timezone Setup (Thailand UTC+7) ──────────────────────────────────
process.env.TZ = 'Asia/Bangkok';

Date.prototype.toJSON = function () {
  const tzOffset = 7 * 60; // UTC+7 offset in minutes
  const localDate = new Date(this.getTime() + tzOffset * 60 * 1000);
  return localDate.toISOString().replace('Z', '+07:00');
};

import errorHandler from './middleware/errorHandler.js';
import authRoutes from './routes/auth.routes.js';
import userRoutes from './routes/user.routes.js';
import activityRoutes from './routes/activity.routes.js';
import checkinRoutes from './routes/checkin.routes.js';
import groupRoutes from './routes/group.routes.js';
import dashboardRoutes from './routes/dashboard.routes.js';
import healthRoutes from './routes/health.routes.js';
import friendRoutes from './routes/friend.routes.js';
import leaderboardRoutes from './routes/leaderboard.routes.js';

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Global Middleware ───────────────────────────────────────────────────────

app.use(helmet());

// Browser origins allowed to call this API. Extra origins can be configured via
// the CORS_ORIGIN env var (comma-separated); the production frontend and local
// dev origins are always allowed so a missing/misconfigured env var can't lock
// legitimate clients out.
const defaultOrigins = [
  'https://step-challenge-frontend.vercel.app', // production web frontend
  'http://localhost:3000',
  'http://localhost:8081',
  'http://localhost:19006', // Expo web dev server
];

const configuredOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const allowedOrigins = [...new Set([...defaultOrigins, ...configuredOrigins])];

// Vercel gives each preview deployment of the frontend a unique subdomain
// (e.g. step-challenge-frontend-git-branch-user.vercel.app), so match those too.
const previewOriginPattern = /^https:\/\/step-challenge-frontend[\w-]*\.vercel\.app$/;

const isAllowedOrigin = (origin) =>
  allowedOrigins.includes(origin) || previewOriginPattern.test(origin);

app.use(cors({
  origin(origin, callback) {
    // Non-browser clients (mobile app, curl, server-to-server) send no Origin header.
    if (!origin || isAllowedOrigin(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`Origin ${origin} not allowed by CORS`));
  },
  credentials: true,
}));
app.use(compression());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Health Check ────────────────────────────────────────────────────────────

app.get('/api/v1/health-check', (_req, res) => {
  res.status(200).json({
    success: true,
    message: 'Faculty Activity Tracker API is running.',
    data: {
      environment: process.env.NODE_ENV || 'development',
      timestamp: new Date(),
      uptime: process.uptime(),
    },
  });
});

// ─── API Routes ──────────────────────────────────────────────────────────────

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/activities', activityRoutes);
app.use('/api/v1/checkins', checkinRoutes);
app.use('/api/v1/groups', groupRoutes);
app.use('/api/v1/dashboard', dashboardRoutes);
app.use('/api/v1/health', healthRoutes);
app.use('/api/v1/friends', friendRoutes);
app.use('/api/v1/leaderboard', leaderboardRoutes);

// ─── 404 Handler ─────────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({
    success: false,
    message: 'The requested endpoint does not exist.',
  });
});

// ─── Global Error Handler ────────────────────────────────────────────────────

app.use(errorHandler);

// ─── Start Server ────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/api/v1/health-check`);
});

export default app;
