'use strict';

const { factories } = require('@strapi/strapi');
const { VALID_USE_CASES } = require('../../../lib/analyzers/analyzerFactory.js');
const { requireUser } = require('../../../utils/appAuth.js');
const { createOne, deleteOne, findMany, requireList, requireWorkspace } = require('../../../utils/store.js');
const { isJobRunning, startScrapeJob } = require('../../../utils/scrapeJobs.js');

module.exports = factories.createCoreController('api::lead-list.lead-list', () => ({
  async list(ctx) {
    const user = requireUser(ctx);
    const { workspaceId } = ctx.query;
    if (!workspaceId) return ctx.badRequest('workspaceId required');
    await requireWorkspace(workspaceId, user.id);

    const lists = await findMany('list', {
      filters: { workspace_id: { $eq: workspaceId } },
      sort: ['createdAt:desc'],
    });

    const leads = await findMany('lead', {
      filters: { workspace_id: { $eq: workspaceId } },
      fields: ['list_id'],
      pagination: { pageSize: 50000 },
    });
    const counts = leads.reduce((acc, lead) => {
      acc[lead.list_id] = (acc[lead.list_id] ?? 0) + 1;
      return acc;
    }, {});

    return lists.map((list) => ({
      ...list,
      lead_count: counts[list.id] ?? 0,
    }));
  },

  async create(ctx) {
    const user = requireUser(ctx);
    const { workspaceId, name, targetLeads = 100, use_case = 'erp' } = ctx.request.body ?? {};
    if (!workspaceId) return ctx.badRequest('workspaceId required');
    if (!name?.trim()) return ctx.badRequest('name required');
    if (!VALID_USE_CASES.includes(use_case)) {
      return ctx.badRequest(`use_case must be one of: ${VALID_USE_CASES.join(', ')}`);
    }

    await requireWorkspace(workspaceId, user.id);
    ctx.status = 201;
    return createOne('list', {
      workspace_id: workspaceId,
      name: name.trim(),
      target_leads: targetLeads,
      use_case,
    });
  },

  async remove(ctx) {
    const user = requireUser(ctx);
    const { workspaceId } = ctx.query;
    if (!workspaceId) return ctx.badRequest('workspaceId required');
    await requireWorkspace(workspaceId, user.id);
    const list = await requireList(ctx.params.id, workspaceId);

    const leads = await findMany('lead', {
      filters: { workspace_id: { $eq: workspaceId }, list_id: { $eq: list.id } },
      pagination: { pageSize: 50000 },
    });
    await Promise.all(leads.map((lead) => deleteOne('lead', lead.id)));
    await deleteOne('list', list.id);

    return { ok: true };
  },

  async extend(ctx) {
    const user = requireUser(ctx);
    const { workspaceId, config = {} } = ctx.request.body ?? {};
    if (!workspaceId) return ctx.badRequest('workspaceId required');

    await requireWorkspace(workspaceId, user.id);
    await requireList(ctx.params.id, workspaceId);

    if (isJobRunning(workspaceId)) {
      return ctx.conflict('A job is already running for this workspace');
    }

    const result = await startScrapeJob({
      workspaceId,
      listId: ctx.params.id,
      config,
    });

    return { ok: true, sessionId: result.sessionId };
  },
}));
