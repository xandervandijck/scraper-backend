/**
 * Analyzer Factory
 *
 * Central registry for use-case analyzers.
 * To add a new use case: import the analyzer and add an entry below.
 *
 * Every analyzer must implement:
 *   analyze({ text, url, domain, extraData, emails })  → { score, analysis_data }
 *   fetchExtra(baseUrl, fetchFn)                        → { extraText, extraData }
 *   generateQueries(config)                             → QuerySpec[]
 */
import ERPAnalyzer         from './erpAnalyzer.js';
import RecruitmentAnalyzer from './recruitmentAnalyzer.js';

const REGISTRY = {
  erp:         ERPAnalyzer,
  recruitment: RecruitmentAnalyzer,
};

/**
 * @param {string} useCase
 * @returns {Analyzer}
 * @throws if useCase is not registered
 */
export function getAnalyzer(useCase) {
  const analyzer = REGISTRY[useCase];
  if (!analyzer) throw new Error(`Unknown use case: "${useCase}". Valid: ${Object.keys(REGISTRY).join(', ')}`);
  return analyzer;
}

export const VALID_USE_CASES = Object.keys(REGISTRY);
