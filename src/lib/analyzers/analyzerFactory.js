'use strict';

/**
 * Analyzer Factory
 *
 * Central registry for use-case analyzers.
 */
const ERPAnalyzer = require('./erpAnalyzer.js');
const RecruitmentAnalyzer = require('./recruitmentAnalyzer.js');
const ProspectingAnalyzer = require('./prospectingAnalyzer.js');

const REGISTRY = {
  erp:         ERPAnalyzer,
  recruitment: RecruitmentAnalyzer,
  prospecting: ProspectingAnalyzer,
};

/**
 * @param {string} useCase
 * @returns {Analyzer}
 * @throws if useCase is not registered
 */
function getAnalyzer(useCase) {
  const analyzer = REGISTRY[useCase];
  if (!analyzer) throw new Error(`Unknown use case: "${useCase}". Valid: ${Object.keys(REGISTRY).join(', ')}`);
  return analyzer;
}

const VALID_USE_CASES = Object.keys(REGISTRY);

module.exports = { getAnalyzer, VALID_USE_CASES };
