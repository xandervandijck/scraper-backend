'use strict';

const bcrypt = require('bcryptjs');
const { factories } = require('@strapi/strapi');
const { createOne, findOne } = require('../../../utils/store.js');
const { signToken } = require('../../../utils/appAuth.js');

module.exports = factories.createCoreController('api::app-user.app-user', () => ({
  async register(ctx) {
    const { email, password } = ctx.request.body ?? {};
    const normalizedEmail = String(email ?? '').toLowerCase().trim();

    if (!normalizedEmail || !password || password.length < 8) {
      return ctx.badRequest('Email and password (min 8 chars) required');
    }

    const existing = await findOne('user', {
      filters: { email: { $eq: normalizedEmail } },
    });
    if (existing) return ctx.conflict('Email already registered');

    const user = await createOne('user', {
      email: normalizedEmail,
      password_hash: await bcrypt.hash(password, 12),
    });

    await createOne('workspace', {
      user_id: user.id,
      name: 'Default Workspace',
    });

    ctx.status = 201;
    return {
      token: signToken(user),
      user: { id: user.id, email: user.email },
    };
  },

  async login(ctx) {
    const { email, password } = ctx.request.body ?? {};
    const normalizedEmail = String(email ?? '').toLowerCase().trim();

    if (!normalizedEmail || !password) {
      return ctx.badRequest('Email and password required');
    }

    const user = await findOne('user', {
      filters: { email: { $eq: normalizedEmail } },
      fields: ['email', 'password_hash'],
    });

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return ctx.unauthorized('Invalid credentials');
    }

    return {
      token: signToken(user),
      user: { id: user.id, email: user.email },
    };
  },
}));
