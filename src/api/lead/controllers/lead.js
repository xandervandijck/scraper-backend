'use strict';

const { factories } = require('@strapi/strapi');
const fs = require('fs');
const path = require('path');
const { exportCSV, exportXLSX } = require('../../../lib/exporter.js');
const { requireUser } = require('../../../utils/appAuth.js');
const { findMany, requireWorkspace } = require('../../../utils/store.js');

function scoreOf(lead) {
  return lead.score ?? lead.erp_score ?? lead.analysis_data?.score ?? 0;
}

function matchesFilters(lead, { listId, minScore = 0, search = '', status, hasEmail }) {
  if (listId && lead.list_id !== listId) return false;
  if (scoreOf(lead) < minScore) return false;
  if (status && lead.lead_status !== status) return false;
  if (hasEmail === true && !lead.email) return false;
  if (hasEmail === false && lead.email) return false;

  if (search) {
    const needle = search.toLowerCase();
    const haystack = [
      lead.company_name,
      lead.companyName,
      lead.email,
      lead.domain,
      lead.category,
      lead.sector,
      lead.city,
    ].filter(Boolean).join(' ').toLowerCase();
    if (!haystack.includes(needle)) return false;
  }

  return true;
}

function toExportLead(lead) {
  return {
    ...lead,
    companyName: lead.company_name,
    allEmails: lead.all_emails,
    hasVacancies: lead.has_vacancies,
    jobTitles: lead.job_titles,
    vacancyLinks: lead.vacancy_links,
    uniqueIdentifier: lead.unique_identifier,
    status: lead.lead_status,
    assessmentReason: lead.assessment_reason,
    city: lead.city,
    score: scoreOf(lead),
  };
}

async function filteredLeads(ctx) {
  const user = requireUser(ctx);
  const { workspaceId, listId, minScore = 0, search = '', status } = ctx.query;
  if (!workspaceId) ctx.throw(400, 'workspaceId required');
  await requireWorkspace(workspaceId, user.id);

  const hasEmail = ctx.query.hasEmail === undefined ? undefined : ctx.query.hasEmail === 'true';
  const rows = await findMany('lead', {
    filters: { workspace_id: { $eq: workspaceId } },
    sort: ['createdAt:desc'],
    pagination: { pageSize: 50000 },
  });

  return rows.filter((lead) => matchesFilters(lead, {
    listId,
    minScore: parseInt(minScore),
    search,
    status,
    hasEmail,
  }));
}

module.exports = factories.createCoreController('api::lead.lead', () => ({
  async list(ctx) {
    const page = parseInt(ctx.query.page ?? '1');
    const limit = parseInt(ctx.query.limit ?? '50');
    const rows = await filteredLeads(ctx);
    const start = (page - 1) * limit;

    return {
      total: rows.length,
      page,
      limit,
      data: rows.slice(start, start + limit),
    };
  },

  async export(ctx) {
    const { format } = ctx.params;
    if (!['csv', 'xlsx'].includes(format)) return ctx.badRequest('format must be csv or xlsx');

    const rows = await filteredLeads(ctx);
    if (!rows.length) return ctx.notFound('No leads to export');

    const filename = `leads_${Date.now()}.${format}`;
    const filepath = format === 'csv'
      ? await exportCSV(rows.map(toExportLead), filename)
      : exportXLSX(rows.map(toExportLead), filename);

    ctx.attachment(`superscraper_leads.${format}`);
    ctx.body = fs.createReadStream(path.resolve(filepath));
  },
}));
