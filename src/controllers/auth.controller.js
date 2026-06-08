import prisma from '../config/prisma.js';
import {
  generateAccessToken,
  generateRefreshToken,
  hashPassword,
  comparePassword,
  verifyRefreshToken,
} from '../services/auth.service.js';

/**
 * Strip sensitive fields from a user object before returning it.
 * @param {Object} user - The Prisma user record.
 * @returns {Object} User object without passwordHash.
 */
function sanitizeUser(user) {
  const { passwordHash, ...safeUser } = user;
  return safeUser;
}

/**
 * POST /auth/register
 * Register a new user account.
 */
export async function register(req, res) {
  try {
    const { email, password, fullName, department } = req.body;

    // Check if email is already registered
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(409).json({
        success: false,
        data: null,
        message: 'Email is already registered.',
      });
    }

    const passwordHash = await hashPassword(password);

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        fullName,
        department,
        role: 'STAFF',
        totalPoints: 0,
      },
    });

    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    return res.status(201).json({
      success: true,
      data: {
        user: sanitizeUser(user),
        accessToken,
        refreshToken,
      },
      message: 'Registration successful.',
    });
  } catch (error) {
    console.error('Register error:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Internal server error.',
    });
  }
}

/**
 * POST /auth/login
 * Authenticate a user and return tokens.
 */
export async function login(req, res) {
  try {
    const { email, password } = req.body;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(401).json({
        success: false,
        data: null,
        message: 'Invalid email or password.',
      });
    }

    const isMatch = await comparePassword(password, user.passwordHash);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        data: null,
        message: 'Invalid email or password.',
      });
    }

    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    return res.status(200).json({
      success: true,
      data: {
        user: sanitizeUser(user),
        accessToken,
        refreshToken,
      },
      message: 'Login successful.',
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Internal server error.',
    });
  }
}

/**
 * POST /auth/refresh-token
 * Issue a new access token using a valid refresh token.
 */
export async function refreshToken(req, res) {
  try {
    const { refreshToken: token } = req.body;

    if (!token) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'Refresh token is required.',
      });
    }

    let decoded;
    try {
      decoded = verifyRefreshToken(token);
    } catch (err) {
      return res.status(401).json({
        success: false,
        data: null,
        message: 'Invalid or expired refresh token.',
      });
    }

    // Ensure the user still exists in the database
    const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
    if (!user) {
      return res.status(401).json({
        success: false,
        data: null,
        message: 'User no longer exists.',
      });
    }

    const newAccessToken = generateAccessToken(user);
    const newRefreshToken = generateRefreshToken(user);

    return res.status(200).json({
      success: true,
      data: {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
      },
      message: 'Token refreshed successfully.',
    });
  } catch (error) {
    console.error('Refresh token error:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Internal server error.',
    });
  }
}

/**
 * GET /auth/me
 * Return the currently authenticated user's profile.
 */
export async function getMe(req, res) {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'User not found.',
      });
    }

    return res.status(200).json({
      success: true,
      data: { user: sanitizeUser(user) },
      message: 'User retrieved successfully.',
    });
  } catch (error) {
    console.error('GetMe error:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Internal server error.',
    });
  }
}

/**
 * PUT /auth/change-password
 * Change the authenticated user's password.
 */
export async function changePassword(req, res) {
  try {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user.id;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'Current password and new password are required.',
      });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'User not found.',
      });
    }

    const isMatch = await comparePassword(currentPassword, user.passwordHash);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        data: null,
        message: 'Incorrect current password.',
      });
    }

    const passwordHash = await hashPassword(newPassword);
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
    });

    return res.status(200).json({
      success: true,
      data: null,
      message: 'Password changed successfully.',
    });
  } catch (error) {
    console.error('Change password error:', error);
    return res.status(500).json({
      success: false,
      data: null,
      message: 'Internal server error.',
    });
  }
}
