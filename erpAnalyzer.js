/**
 * ERP Fit Analyzer — scores a company website on ERP readiness.
 *
 * Four weighted dimensions:
 *   Logistics   30 pts
 *   Complexity  25 pts
 *   B2B         25 pts
 *   Growth      20 pts
 * Total: 100 pts
 */

const SIGNALS = {
  logistics: {
    weight: 30,
    nl: [
      'magazijn', 'warehouse', 'voorraad', 'logistiek', 'levering', 'bezorging',
      'distributie', 'transport', 'opslag', 'pallets', 'vrachtbrief', 'stijfsel',
      'order management', 'fulfillment', 'pick and pack', 'cross-dock',
    ],
    de: [
      'lager', 'lagerverwaltung', 'logistik', 'lieferung', 'distribution',
      'transport', 'versand', 'kommissionierung', 'lagerbestand',
    ],
    en: [
      'warehouse', 'inventory', 'logistics', 'delivery', 'distribution',
      'transport', 'storage', 'fulfillment', 'shipping', 'dispatch',
      'stock management', 'supply chain',
    ],
  },
  complexity: {
    weight: 25,
    nl: [
      'meerdere locaties', 'vestigingen', 'filialen', 'internationale handel',
      'import', 'export', 'productie', 'manufacturing', 'assemblage',
      'subcontractors', 'kwaliteitscontrole', 'ISO', 'compliance',
      'batch tracking', 'serienummer', 'productconfiguratie',
    ],
    de: [
      'mehrere standorte', 'filialen', 'internationaler handel', 'produktion',
      'fertigung', 'qualitätskontrolle', 'ISO zertifiziert',
    ],
    en: [
      'multiple locations', 'branches', 'international trade', 'import', 'export',
      'manufacturing', 'production', 'quality control', 'ISO certified',
      'compliance', 'batch tracking', 'serial numbers',
    ],
  },
  b2b: {
    weight: 25,
    nl: [
      'groothandel', 'zakelijke klanten', 'B2B', 'inkooporder', 'offerte',
      'bestelformulier', 'dealer', 'reseller', 'wederverkoop', 'handelspartner',
      'accountmanager', 'klantenportaal', 'inloggen klant', 'vakhandel',
    ],
    de: [
      'großhandel', 'geschäftskunden', 'B2B', 'bestellformular', 'händler',
      'wiederverkäufer', 'kundenkonto', 'fachhändler',
    ],
    en: [
      'wholesale', 'business customers', 'B2B', 'purchase order', 'quote',
      'order form', 'dealer', 'reseller', 'trade customer', 'account manager',
      'customer portal', 'login', 'trade account',
    ],
  },
  growth: {
    weight: 20,
    nl: [
      'groeien', 'uitbreiding', 'nieuw kantoor', 'nieuwe vestiging',
      'investering', 'personeel gezocht', 'vacature', 'wij zoeken',
      'digitalisering', 'automatisering', 'innovatie', 'optimalisatie',
    ],
    de: [
      'wachstum', 'erweiterung', 'neues büro', 'investition', 'stellenangebote',
      'digitalisierung', 'automatisierung', 'innovation',
    ],
    en: [
      'growing', 'expansion', 'new office', 'investment', 'we are hiring',
      'vacancy', 'digitalization', 'automation', 'innovation', 'optimize',
      'scale', 'modernize',
    ],
  },
};

// Pre-build flat lists for fast matching
const FLAT_SIGNALS = {};
for (const [dim, data] of Object.entries(SIGNALS)) {
  FLAT_SIGNALS[dim] = [
    ...new Set([...(data.nl || []), ...(data.de || []), ...(data.en || [])]),
  ].map((s) => s.toLowerCase());
}

/**
 * @param {string} text      - all scraped text from website
 * @param {string} [url='']  - website URL (for additional heuristics)
 * @returns {{ score: number, breakdown: object, signals: object }}
 */
export function analyzeERPFit(text, url = '') {
  const lower = (text || '').toLowerCase();

  const breakdown = {};
  const matchedSignals = {};
  let total = 0;

  for (const [dim, data] of Object.entries(SIGNALS)) {
    const flat = FLAT_SIGNALS[dim];
    const hits = flat.filter((signal) => lower.includes(signal));
    const hitCount = hits.length;

    // Score: hits → points, capped at weight
    // 3+ hits = full weight, 2 hits = 70%, 1 hit = 40%, 0 = 0
    let dimScore = 0;
    if (hitCount >= 3) dimScore = data.weight;
    else if (hitCount === 2) dimScore = Math.round(data.weight * 0.7);
    else if (hitCount === 1) dimScore = Math.round(data.weight * 0.4);

    breakdown[dim] = { score: dimScore, max: data.weight, hits: hitCount };
    matchedSignals[dim] = hits.slice(0, 5); // top 5
    total += dimScore;
  }

  // URL bonus: .nl/.be/.de domains get a small B2B signal boost
  if (/\.(nl|be|de)\b/.test(url) && breakdown.b2b.score === 0) {
    breakdown.b2b.score = 2;
    total += 2;
  }

  return {
    score: Math.min(100, total),
    breakdown,
    signals: matchedSignals,
  };
}

export default { analyzeERPFit };
