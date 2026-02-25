import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query, withTransaction } from '../db.js';
import { asyncHandler } from '../middleware/authMiddleware.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;

function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
}

/** POST /auth/register */
router.post('/register', asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password || password.length < 8) {
    return res.status(400).json({ error: 'Email and password (min 8 chars) required' });
  }

  const hash = await bcrypt.hash(password, 12);

  const user = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO users (email, password_hash)
       VALUES ($1, $2)
       RETURNING id, email, created_at`,
      [email.toLowerCase().trim(), hash]
    );
    const newUser = rows[0];

    // Create default workspace for every new user
    await client.query(
      `INSERT INTO workspaces (user_id, name) VALUES ($1, 'Default Workspace')`,
      [newUser.id]
    );

    return newUser;
  });

  res.status(201).json({
    token: signToken(user),
    user: { id: user.id, email: user.email },
  });
}));

/** POST /auth/login */
router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  const { rows } = await query(
    'SELECT id, email, password_hash FROM users WHERE email = $1',
    [email.toLowerCase().trim()]
  );
  const user = rows[0];

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  res.json({
    token: signToken(user),
    user: { id: user.id, email: user.email },
  });
}));

export default router;
