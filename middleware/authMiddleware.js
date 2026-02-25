import jwt from 'jsonwebtoken';
import { query } from '../db.js';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET environment variable is required');

/** Verify Bearer token and attach req.userId */
export function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    req.userId = payload.sub;
    req.userEmail = payload.email;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Verify the workspace belongs to the authenticated user.
 * Reads workspaceId from body, query params, or route params (in that order).
 * Sets req.workspaceId on success.
 */
export async function verifyWorkspace(req, res, next) {
  const workspaceId =
    req.body?.workspaceId ||
    req.query?.workspaceId ||
    req.params?.workspaceId;

  if (!workspaceId) {
    return res.status(400).json({ error: 'workspaceId required' });
  }

  try {
    const { rows } = await query(
      'SELECT id FROM workspaces WHERE id = $1 AND user_id = $2',
      [workspaceId, req.userId]
    );
    if (!rows.length) {
      return res.status(403).json({ error: 'Workspace not found or access denied' });
    }
    req.workspaceId = workspaceId;
    next();
  } catch (err) {
    next(err);
  }
}

/** Wraps async route handlers to forward errors to Express error handler */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
