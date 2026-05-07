'use strict';

const LEGACY_PREFIXES = [
  '/auth',
  '/workspaces',
  '/lists',
  '/leads',
  '/download',
  '/scrape',
  '/config',
];

module.exports = () => async (ctx, next) => {
  if (LEGACY_PREFIXES.some((prefix) => ctx.path === prefix || ctx.path.startsWith(`${prefix}/`))) {
    ctx.path = `/api${ctx.path}`;
  }
  await next();
};
