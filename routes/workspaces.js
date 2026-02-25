import express from 'express';
import { query } from '../db.js';
import { authenticate, asyncHandler } from '../middleware/authMiddleware.js';

const router = express.Router();
router.use(authenticate);

router.get('/', asyncHandler(async (req, res) => {
  const { rows } = await query(
    'SELECT id, name, created_at FROM workspaces WHERE user_id = $1 ORDER BY created_at',
    [req.userId]
  );
  res.json(rows);
}));

router.post('/', asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  const { rows } = await query(
    'INSERT INTO workspaces (user_id, name) VALUES ($1, $2) RETURNING id, name, created_at',
    [req.userId, name.trim()]
  );
  res.status(201).json(rows[0]);
}));

export default router;
