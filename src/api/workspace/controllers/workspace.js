'use strict';

const { factories } = require('@strapi/strapi');
const { requireUser } = require('../../../utils/appAuth.js');
const { createOne, findMany } = require('../../../utils/store.js');

module.exports = factories.createCoreController('api::workspace.workspace', () => ({
  async list(ctx) {
    const user = requireUser(ctx);
    return findMany('workspace', {
      filters: { user_id: { $eq: user.id } },
      sort: ['createdAt:asc'],
    });
  },

  async create(ctx) {
    const user = requireUser(ctx);
    const { name } = ctx.request.body ?? {};
    if (!name?.trim()) return ctx.badRequest('name required');

    ctx.status = 201;
    return createOne('workspace', {
      user_id: user.id,
      name: name.trim(),
    });
  },
}));
