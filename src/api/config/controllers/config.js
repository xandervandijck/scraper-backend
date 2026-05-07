'use strict';

const { getAnalyzer } = require('../../../lib/analyzers/analyzerFactory.js');
const { loadSectors, saveSectors } = require('../../../lib/queryGenerator.js');
const { requireUser } = require('../../../utils/appAuth.js');

module.exports = {
  sectors(ctx) {
    requireUser(ctx);
    const useCase = ctx.query.useCase ?? 'erp';
    if (useCase === 'erp') return loadSectors();

    const analyzer = getAnalyzer(useCase);
    return analyzer.sectors ?? [];
  },

  saveSectors(ctx) {
    requireUser(ctx);
    const sectors = ctx.request.body;
    if (!Array.isArray(sectors)) return ctx.badRequest('Body must be an array of sector objects');

    for (const sector of sectors) {
      if (!sector.key || !sector.label || !Array.isArray(sector.queries)) {
        return ctx.badRequest('Each sector needs key, label, and queries[]');
      }
    }

    saveSectors(sectors);
    return { ok: true, count: sectors.length };
  },
};
