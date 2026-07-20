import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockPrisma } from '../test-utils/mockPrisma.js';

const mockPrisma = createMockPrisma();
vi.mock('../config/prisma.js', () => ({ default: mockPrisma }));

const verifyGoogleIdToken = vi.fn();
vi.mock('../services/googleAuth.service.js', () => ({ verifyGoogleIdToken }));

vi.mock('../services/auth.service.js', () => ({
  generateAccessToken: () => 'access-token',
  generateRefreshToken: () => 'refresh-token',
  hashPassword: async (p) => `hashed:${p}`,
  comparePassword: async () => true,
  verifyRefreshToken: () => ({}),
}));

vi.mock('../services/userSanitizer.service.js', () => ({
  sanitizeUser: (u) => u,
}));

const { googleSignIn } = await import('./auth.controller.js');

/** Minimal Express `res` double that records what the controller sent. */
const makeRes = () => {
  const res = { statusCode: undefined, body: undefined };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  return res;
};

const identity = (overrides = {}) => ({
  googleId: 'google-sub-123',
  email: 'staff@eng.chula.ac.th',
  fullName: 'Somchai Staff',
  avatarUrl: null,
  emailVerified: true,
  ...overrides,
});

/**
 * BUILD_PLAN.md Phase 9, Task 4 — Google OAuth hardening.
 *
 * The hole being closed: `googleSignIn` used to auto-link a Google identity to
 * an existing account purely on an email match, ignoring the `emailVerified`
 * flag that `verifyGoogleIdToken` already returns. Anyone able to present a
 * token whose unverified `email` claim matched a staff account would be handed
 * that account. The fix gates the LINK path (not the sign-up path) on
 * `emailVerified === true`.
 */
describe('googleSignIn — emailVerified gate on account auto-link', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects auto-linking to an existing account when Google says the email is unverified', async () => {
    verifyGoogleIdToken.mockResolvedValue(identity({ emailVerified: false }));
    // No user with this googleId...
    mockPrisma.user.findUnique.mockResolvedValueOnce(null);
    // ...but the email already belongs to a password account.
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'existing-user-1',
      email: 'staff@eng.chula.ac.th',
      passwordHash: 'hashed:hunter2',
    });

    const res = makeRes();
    await googleSignIn({ body: { idToken: 'tok' } }, res);

    expect(res.statusCode).toBe(403);
    expect(res.body.success).toBe(false);
    // The critical assertion: the takeover write never happened.
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
    expect(res.body.data).toBeNull();
  });

  it('allows auto-linking when the email is verified', async () => {
    verifyGoogleIdToken.mockResolvedValue(identity({ emailVerified: true }));
    mockPrisma.user.findUnique.mockResolvedValueOnce(null);
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'existing-user-1',
      email: 'staff@eng.chula.ac.th',
      passwordHash: 'hashed:hunter2',
    });
    mockPrisma.user.update.mockResolvedValue({
      id: 'existing-user-1',
      email: 'staff@eng.chula.ac.th',
      googleId: 'google-sub-123',
    });

    const res = makeRes();
    await googleSignIn({ body: { idToken: 'tok' } }, res);

    expect(res.statusCode).toBe(200);
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'existing-user-1' },
      data: { googleId: 'google-sub-123' },
    });
    expect(res.body.data.accessToken).toBe('access-token');
  });

  it('still creates a brand-new account even when the email is unverified', async () => {
    // Sign-UP is deliberately not gated: a new account with an unverified
    // email grants access to nothing that existed before.
    verifyGoogleIdToken.mockResolvedValue(identity({ emailVerified: false }));
    mockPrisma.user.findUnique.mockResolvedValueOnce(null); // no googleId match
    mockPrisma.user.findUnique.mockResolvedValueOnce(null); // no email match
    mockPrisma.user.create.mockResolvedValue({
      id: 'new-user-1',
      email: 'staff@eng.chula.ac.th',
      googleId: 'google-sub-123',
      role: 'STAFF',
    });

    const res = makeRes();
    await googleSignIn({ body: { idToken: 'tok' } }, res);

    expect(res.statusCode).toBe(200);
    expect(mockPrisma.user.create).toHaveBeenCalled();
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('logs in an already-linked account without re-checking emailVerified', async () => {
    // Once googleId is on the record the link was established previously, so
    // an unverified flag on this particular token must not lock the user out.
    verifyGoogleIdToken.mockResolvedValue(identity({ emailVerified: false }));
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'linked-user-1',
      email: 'staff@eng.chula.ac.th',
      googleId: 'google-sub-123',
    });

    const res = makeRes();
    await googleSignIn({ body: { idToken: 'tok' } }, res);

    expect(res.statusCode).toBe(200);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });

  it('returns 401 when the token itself is invalid', async () => {
    verifyGoogleIdToken.mockRejectedValue(new Error('Invalid Google token.'));

    const res = makeRes();
    await googleSignIn({ body: { idToken: 'bad' } }, res);

    expect(res.statusCode).toBe(401);
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });
});
