import express from 'express';
import { query } from '../db.js';
import { authenticate, verifyWorkspace, asyncHandler } from '../middleware/authMiddleware.js';
import { startScrapeJob, isJobRunning } from '../services/scrapeService.js';

const router = express.Router();
router.use(authenticate);

router.get('/', asyncHandler(async (req, res) => {
  const { workspaceId } = req.query;
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });

  // Verify ownership
  const { rows: ws } = await query(
    'SELECT id FROM workspaces WHERE id = $1 AND user_id = $2',
    [workspaceId, req.userId]
  );
  if (!ws.length) return res.status(403).json({ error: 'Workspace not found' });

  const { rows } = await query(
    `SELECT l.*, COUNT(ld.id)::int AS lead_count
     FROM lead_lists l
     LEFT JOIN leads ld ON ld.list_id = l.id
     WHERE l.workspace_id = $1
     GROUP BY l.id ORDER BY l.created_at DESC`,
    [workspaceId]
  );
  res.json(rows);
}));

router.post('/', verifyWorkspace, asyncHandler(async (req, res) => {
  const { name, targetLeads = 100 } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  const { rows } = await query(
    'INSERT INTO lead_lists (workspace_id, name, target_leads) VALUES ($1,$2,$3) RETURNING *',
    [req.workspaceId, name.trim(), targetLeads]
  );
  res.status(201).json(rows[0]);
}));

/** POST /lists/:id/extend — run more scraping into an existing list */
router.post('/:id/extend', asyncHandler(async (req, res) => {
  const { workspaceId, config = {} } = req.body;
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });

  // Verify workspace ownership + list belongs to workspace
  const { rows: ws } = await query(
    'SELECT id FROM workspaces WHERE id = $1 AND user_id = $2',
    [workspaceId, req.userId]
  );
  if (!ws.length) return res.status(403).json({ error: 'Workspace not found' });

  const { rows: list } = await query(
    'SELECT id FROM lead_lists WHERE id = $1 AND workspace_id = $2',
    [req.params.id, workspaceId]
  );
  if (!list.length) return res.status(404).json({ error: 'List not found' });

  if (isJobRunning(workspaceId)) {
    return res.status(409).json({ error: 'A job is already running for this workspace' });
  }

  const broadcast = (data) => req.app.get('broadcastToUser')(req.userId, data);

  const sessionId = await startScrapeJob({
    workspaceId,
    listId: req.params.id,
    config,
    broadcast,
  });

  res.json({ ok: true, sessionId });
}));

export default router;
