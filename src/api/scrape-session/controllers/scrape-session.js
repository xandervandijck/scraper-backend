'use strict';

const { factories } = require('@strapi/strapi');
const { requireUser } = require('../../../utils/appAuth.js');
const { requireList, requireWorkspace } = require('../../../utils/store.js');
const { forceStopJob, getJobStatus, getSessions, isJobRunning, startScrapeJob, stopJob } = require('../../../utils/scrapeJobs.js');

module.exports = factories.createCoreController('api::scrape-session.scrape-session', () => ({
  async start(ctx) {
    const user = requireUser(ctx);
    const { workspaceId, listId, config = {} } = ctx.request.body ?? {};
    if (!workspaceId || !listId) return ctx.badRequest('workspaceId and listId required');

    await requireWorkspace(workspaceId, user.id);
    await requireList(listId, workspaceId);

    if (isJobRunning(workspaceId)) return ctx.conflict('Job already running for this workspace');

    const result = await startScrapeJob({ workspaceId, listId, config });
    return { ok: true, ...result };
  },

  async stop(ctx) {
    const user = requireUser(ctx);
    const { workspaceId, force = false } = ctx.request.body ?? {};
    if (!workspaceId) return ctx.badRequest('workspaceId required');
    await requireWorkspace(workspaceId, user.id);

    if (force) {
      forceStopJob(workspaceId);
      return { ok: true, forced: true };
    }

    return { ok: stopJob(workspaceId) };
  },

  async status(ctx) {
    const user = requireUser(ctx);
    const { workspaceId } = ctx.query;
    if (!workspaceId) return ctx.badRequest('workspaceId required');
    await requireWorkspace(workspaceId, user.id);
    return getJobStatus(workspaceId);
  },

  async sessions(ctx) {
    const user = requireUser(ctx);
    const { workspaceId, listId } = ctx.query;
    if (!workspaceId) return ctx.badRequest('workspaceId required');
    await requireWorkspace(workspaceId, user.id);
    return getSessions(workspaceId, listId);
  },
}));
