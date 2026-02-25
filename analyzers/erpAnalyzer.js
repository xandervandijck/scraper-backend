/**
 * ERP Analyzer — adapter wrapping the original analyzeERPFit function.
 * The core logic in ../erpAnalyzer.js is NOT modified.
 */
import { analyzeERPFit } from '../erpAnalyzer.js';
import { generateQueries } from '../queryGenerator.js';

const ERPAnalyzer = {
  /** @returns {{ score: number, analysis_data: object }} */
  analyze({ text, url }) {
    const { score, breakdown, signals } = analyzeERPFit(text, url);
    return {
      score,
      analysis_data: { breakdown, signals },
    };
  },

  /** No extra pages needed — ERP scores from homepage + contact only */
  async fetchExtra() {
    return { extraText: '', extraData: {} };
  },

  generateQueries(config) {
    return generateQueries({
      sectorKeys: config.sectorKeys ?? [],
      countryKeys: config.countryKeys ?? [],
    });
  },
};

export default ERPAnalyzer;
