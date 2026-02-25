import express from 'express';
import { authenticate, asyncHandler } from '../middleware/authMiddleware.js';
import { getLeads, countLeads } from '../services/leadService.js';
import { query } from '../db.js';

const router = express.Router();
router.use(authenticate);

router.get('/', asyncHandler(async (req, res) => {
  const { workspaceId, listId, page = 1, limit = 50, minScore = 0, search = '' } = req.query;
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });

  const { rows: ws } = await query('SELECT id FROM workspaces WHERE id=$1 AND user_id=$2', [workspaceId, req.userId]);
  if (!ws.length) return res.status(403).json({ error: 'Workspace not found' });

  const offset = (parseInt(page) - 1) * parseInt(limit);
  const [rows, total] = await Promise.all([
    getLeads(workspaceId, { listId, limit: parseInt(limit), offset, minScore: parseInt(minScore), search }),
    listId ? countLeads(workspaceId, listId) : Promise.resolve(0),
  ]);
  res.json({ total, page: parseInt(page), limit: parseInt(limit), data: rows });
}));

export default router;
