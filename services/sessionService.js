import { query } from '../db.js';

export async function createSession(workspaceId, listId, config, queries) {
  const { rows } = await query(
    `INSERT INTO scrape_sessions (workspace_id, list_id, status, config, queries_used)
     VALUES ($1, $2, 'running', $3, $4) RETURNING id`,
    [workspaceId, listId, JSON.stringify(config), JSON.stringify(queries)]
  );
  return rows[0].id;
}

export async function updateSession(sessionId, { leadsFound, duplicatesSkipped, errorsCount, status }) {
  await query(
    `UPDATE scrape_sessions SET
       leads_found = $1, duplicates_skipped = $2, errors_count = $3, status = $4,
       finished_at = CASE WHEN $4 IN ('done','stopped','error') THEN NOW() ELSE finished_at END
     WHERE id = $5`,
    [leadsFound ?? 0, duplicatesSkipped ?? 0, errorsCount ?? 0, status, sessionId]
  );
}

export async function getSessions(workspaceId, listId = null) {
  const params = [workspaceId];
  let sql = `
    SELECT s.*, l.name AS list_name
    FROM scrape_sessions s
    LEFT JOIN lead_lists l ON l.id = s.list_id
    WHERE s.workspace_id = $1`;
  if (listId) { params.push(listId); sql += ` AND s.list_id = $${params.length}`; }
  sql += ' ORDER BY s.started_at DESC LIMIT 50';
  const { rows } = await query(sql, params);
  return rows;
}
