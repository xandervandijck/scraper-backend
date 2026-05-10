'use strict';

/**
 * ERP Analyzer — adapter wrapping the analyzeERPFit function.
 */
const { analyzeERPFit } = require('../erpAnalyzer.js');
const { generateQueries, generateExhaustiveQueries } = require('../queryGenerator.js');

const ERPAnalyzer = {
  /** @returns {{ score: number, analysis_data: object }} */
  analyze({ text, url }) {
    const { score, breakdown, signals } = analyzeERPFit(text, url);
    return {
      score,
      analysis_data: { breakdown, signals },
    };
  },

  async fetchExtra() {
    return { extraText: '', extraData: {} };
  },

  generateQueries(config) {
    return generateQueries({
      sectorKeys: config.sectorKeys ?? [],
      countryKeys: config.countryKeys ?? [],
    });
  },

  generateExhaustiveQueries(config) {
    return generateExhaustiveQueries({
      sectorKeys: config.sectorKeys ?? [],
      countryKeys: config.countryKeys ?? [],
    });
  },
};

module.exports = ERPAnalyzer;
