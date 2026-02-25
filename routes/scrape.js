import express from 'express';
import { authenticate, asyncHandler } from '../middleware/authMiddleware.js';
import { startScrapeJob, stopJob, getJobStatus, isJobRunning } from '../services/scrapeService.js';
import { getSessions } from '../services/sessionService.js';
import { query } from '../db.js';

const router = express.Router();
router.use(authenticate);

router.post('/start', asyncHandler(async (req, res) => {
  const { workspaceId, listId, config = {} } = req.body;
  if (!workspaceId || !listId) return res.status(400).json({ error: 'workspaceId and listId required' });

  const { rows: ws } = await query('SELECT id FROM workspaces WHERE id=$1 AND user_id=$2', [workspaceId, req.userId]);
  if (!ws.length) return res.status(403).json({ error: 'Workspace not found' });

  const { rows: list } = await query('SELECT id FROM lead_lists WHERE id=$1 AND workspace_id=$2', [listId, workspaceId]);
  if (!list.length) return res.status(404).json({ error: 'List not found' });

  if (isJobRunning(workspaceId)) return res.status(409).json({ error: 'Job already running for this workspace' });

  const broadcast = (data) => req.app.get('broadcastToUser')(req.userId, data);
  const sessionId = await startScrapeJob({ workspaceId, listId, config, broadcast });
  res.json({ ok: true, sessionId });
}));

router.post('/stop', asyncHandler(async (req, res) => {
  const { workspaceId } = req.body;
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
  const stopped = stopJob(workspaceId);
  res.json({ ok: stopped });
}));

router.get('/status', asyncHandler(async (req, res) => {
  const { workspaceId } = req.query;
  res.json(getJobStatus(workspaceId) ?? { running: false });
}));

router.get('/sessions', asyncHandler(async (req, res) => {
  const { workspaceId, listId } = req.query;
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
  const { rows: ws } = await query('SELECT id FROM workspaces WHERE id=$1 AND user_id=$2', [workspaceId, req.userId]);
  if (!ws.length) return res.status(403).json({ error: 'Workspace not found' });
  res.json(await getSessions(workspaceId, listId));
}));

export default router;
