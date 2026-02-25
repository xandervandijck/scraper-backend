import { query } from '../db.js';

function normalizeDomain(raw) {
  try {
    const url = raw?.startsWith('http') ? raw : `https://${raw}`;
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase().trim();
  } catch {
    return raw?.toLowerCase().replace(/^www\./, '').trim() ?? null;
  }
}

/** Insert lead with deduplication. Returns { inserted, id?, reason? } */
export async function insertLeadDeduped(client, lead, workspaceId, listId) {
  const domain = normalizeDomain(lead.domain ?? lead.website);
  if (!domain) return { inserted: false, reason: 'invalid_domain' };

  const useCase = lead.useCase ?? 'erp';
  // ERP backward compat: keep erp_score/erp_breakdown populated for ERP leads
  const erpScore    = useCase === 'erp' ? (lead.score ?? null) : null;
  const erpBreakdown = useCase === 'erp' ? (lead.analysisData?.breakdown ?? null) : null;

  const { rows } = await client.query(
    `INSERT INTO leads (
       workspace_id, list_id, company_name, domain, website,
       email, email_valid, email_validation_score, email_validation_reason,
       erp_score, erp_breakdown,
       use_case, analysis_data,
       sector, country, phone, address, description, source
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     ON CONFLICT (workspace_id, domain) DO NOTHING
     RETURNING id`,
    [
      workspaceId, listId, lead.companyName ?? null, domain, lead.website ?? null,
      lead.email ?? null, lead.emailValid ?? null,
      lead.emailValidationScore ?? null, lead.emailValidationReason ?? null,
      erpScore,
      erpBreakdown ? JSON.stringify(erpBreakdown) : null,
      useCase,
      lead.analysisData ? JSON.stringify(lead.analysisData) : null,
      lead.sector ?? null, lead.country ?? null,
      lead.phone ?? null, lead.address ?? null,
      (lead.description ?? '').slice(0, 500), 'puppeteer',
    ]
  );

  return rows.length > 0
    ? { inserted: true, id: rows[0].id }
    : { inserted: false, reason: 'duplicate' };
}

/** Paginated lead query with workspace isolation enforced */
export async function getLeads(workspaceId, { listId, limit = 50, offset = 0, minScore = 0, search = '' } = {}) {
  // Generic score: ERP leads use erp_score, others use analysis_data->>'score'
  const scoreExpr = `COALESCE(erp_score, (analysis_data->>'score')::int, 0)`;
  const params = [workspaceId, minScore];
  let sql = `SELECT *, ${scoreExpr} AS score FROM leads WHERE workspace_id = $1 AND ${scoreExpr} >= $2`;

  if (listId) { params.push(listId); sql += ` AND list_id = $${params.length}`; }
  if (search) {
    params.push(`%${search}%`);
    sql += ` AND (company_name ILIKE $${params.length} OR email ILIKE $${params.length} OR domain ILIKE $${params.length})`;
  }

  params.push(limit, offset);
  sql += ` ORDER BY ${scoreExpr} DESC NULLS LAST, created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

  const { rows } = await query(sql, params);
  return rows;
}

export async function countLeads(workspaceId, listId) {
  const { rows } = await query(
    'SELECT COUNT(*) FROM leads WHERE workspace_id = $1 AND list_id = $2',
    [workspaceId, listId]
  );
  return parseInt(rows[0].count);
}
