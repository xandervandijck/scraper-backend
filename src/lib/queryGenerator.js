'use strict';

/**
 * Query generator: produces search queries from sector × country combinations.
 * Sectors are loaded from config/sectors.json (hot-reloadable via loadSectors()).
 */

const fs = require('fs');
const path = require('path');

const SECTORS_PATH = path.join(__dirname, 'config', 'sectors.json');
const CITIES_PATH = path.join(__dirname, 'config', 'cities.json');

const COUNTRIES = {
  NL: { label: 'Nederland', suffix: 'Nederland site:.nl' },
  BE: { label: 'België', suffix: 'België site:.be' },
  DE: { label: 'Duitsland', suffix: 'Deutschland site:.de' },
};

/** Read sectors from disk (synchronous — called at startup and on demand) */
function loadSectors() {
  try {
    const raw = fs.readFileSync(SECTORS_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('[queryGenerator] Failed to load sectors.json:', err.message);
    return [];
  }
}

/** Write sectors to disk */
function saveSectors(sectors) {
  fs.writeFileSync(SECTORS_PATH, JSON.stringify(sectors, null, 2), 'utf-8');
}

/** Read cities from disk */
function loadCities() {
  try {
    const raw = fs.readFileSync(CITIES_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { NL: [], BE: [], DE: [] };
  }
}

/**
 * @param {object} config
 * @param {string[]} config.sectorKeys  - which sectors to include (empty = all)
 * @param {string[]} config.countryKeys - which countries to include (empty = all)
 * @param {object[]} [config.sectors]   - override sector list (optional, uses file otherwise)
 * @returns {{ query: string, sector: string, country: string, sectorKey: string, countryKey: string }[]}
 */
function generateQueries({
  sectorKeys = [],
  countryKeys = [],
  sectors: sectorOverride,
} = {}) {
  const allSectors = sectorOverride ?? loadSectors();

  const sectors = sectorKeys.length
    ? allSectors.filter((s) => sectorKeys.includes(s.key))
    : allSectors;

  const countries = Object.entries(COUNTRIES).filter(
    ([k]) => !countryKeys.length || countryKeys.includes(k),
  );

  const specs = [];
  for (const sector of sectors) {
    for (const [countryKey, country] of countries) {
      for (const baseQuery of sector.queries) {
        specs.push({
          query: `${baseQuery} ${country.suffix}`,
          keywords: baseQuery,
          sector: sector.label,
          country: country.label,
          sectorKey: sector.key,
          countryKey,
        });
      }
    }
  }
  return specs;
}

/**
 * Generates city-level queries for exhaustive coverage of a country.
 * Instead of one national query, produces one query per major city.
 */
function generateExhaustiveQueries({
  sectorKeys = [],
  countryKeys = [],
  sectors: sectorOverride,
} = {}) {
  const allSectors = sectorOverride ?? loadSectors();
  const sectors = sectorKeys.length
    ? allSectors.filter((s) => sectorKeys.includes(s.key))
    : allSectors;

  const countries = Object.entries(COUNTRIES).filter(
    ([k]) => !countryKeys.length || countryKeys.includes(k),
  );

  const cities = loadCities();
  const specs = [];

  for (const sector of sectors) {
    for (const [countryKey, country] of countries) {
      const tld = countryKey === 'BE' ? 'site:.be' : countryKey === 'DE' ? 'site:.de' : 'site:.nl';
      const countryCities = cities[countryKey] ?? [];
      for (const city of countryCities) {
        for (const baseQuery of sector.queries) {
          specs.push({
            query: `${baseQuery} ${city} ${tld}`,
            keywords: baseQuery,
            sector: sector.label,
            country: country.label,
            sectorKey: sector.key,
            countryKey,
            city,
          });
        }
      }
    }
  }
  return specs;
}

module.exports = { COUNTRIES, loadSectors, saveSectors, loadCities, generateQueries, generateExhaustiveQueries };
