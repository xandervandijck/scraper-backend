/**
 * Recruitment Analyzer
 *
 * Scores a company on outsourcing / recruitment appeal:
 *   Vacancies presence  35 pts
 *   Vacancy count       25 pts
 *   Growth signals      20 pts
 *   HR contact          10 pts
 *   ATS detected        10 pts
 * Total: 100 pts
 */
import axios from 'axios';
import * as cheerio from 'cheerio';

// ─── Vacancy page patterns ────────────────────────────────────────────────────
const VACANCY_PATH_PATTERNS = [
  /\/(vacatures?|vacature|jobs?|careers?|werken-bij|werken_bij|werkenbij|stellenangebote|stellen|karriere|jobangebote|hiring|join-us|join_us|offres-emploi|emploi)[/-]?(\?.*)?$/i,
];

// ─── ATS platforms ────────────────────────────────────────────────────────────
const ATS_SIGNATURES = {
  teamtailor:    /teamtailor\.com/i,
  recruitee:     /recruitee\.com/i,
  workable:      /apply\.workable\.com/i,
  greenhouse:    /boards\.greenhouse\.io/i,
  lever:         /jobs\.lever\.co/i,
  bamboohr:      /bamboohr\.com/i,
  personio:      /join\.com|personio\.de/i,
  homerun:       /homerun\.team/i,
  connexys:      /connexys/i,
  talentsoft:    /talentsoft/i,
  simplyhired:   /simplyhired/i,
};

// ─── Growth signals ───────────────────────────────────────────────────────────
const GROWTH_SIGNALS = [
  'wij groeien', 'we groeien', 'snelgroeiend', 'groeiend bedrijf',
  'we are growing', 'fast growing', 'rapid growth', 'scale-up',
  'wir wachsen', 'wachsendes unternehmen',
  'nieuwe vestiging', 'uitbreiding', 'expansion', 'erweiterung',
  'investering', 'investment', 'serie a', 'serie b', 'funding',
  'wij zoeken', 'we zijn op zoek', 'kom ons team versterken',
  'join our team', 'join us', 'werde teil',
];

// ─── Job category keywords → label ───────────────────────────────────────────
const JOB_CATEGORY_MAP = {
  IT:            ['developer', 'software', 'devops', 'data engineer', 'ict', 'programmer', 'it-er', 'fullstack', 'backend', 'frontend'],
  Logistiek:     ['chauffeur', 'logistiek', 'magazijn', 'warehouse', 'vrachtwagen', 'transport', 'bezorger', 'orderpicker'],
  Finance:       ['accountant', 'controller', 'boekhouder', 'financieel', 'finance', 'administrateur'],
  HR:            ['recruiter', 'hr-medewerker', 'personeelszaken', 'human resources', 'talentmanager'],
  Sales:         ['accountmanager', 'sales', 'commercieel', 'binnendienst', 'buitendienst', 'verkoop'],
  Techniek:      ['monteur', 'technisch', 'installateur', 'service engineer', 'werktuigbouwkunde', 'mechatronica'],
  Productie:     ['productiemedewerker', 'operator', 'assemblagemedewerker', 'kwaliteitscontrole', 'produktie'],
  Management:    ['manager', 'directeur', 'teamleider', 'hoofd', 'leidinggevende'],
  Horeca:        ['kok', 'chef', 'kelner', 'bediening', 'barista', 'receptionist', 'hotelmedewerker', 'catering', 'horeca'],
  Zorg:          ['verpleegkundige', 'verzorgende', 'tandarts', 'fysiotherapeut', 'huisarts', 'apotheker', 'doktersassistent', 'zorgmedewerker', 'zorg'],
  Retail:        ['verkoopmedewerker', 'kassamedewerker', 'winkelmedewerker', 'filiaalmanager', 'retail'],
  Leisure:       ['instructeur', 'trainer', 'begeleider', 'animator', 'evenement', 'sportschool', 'wellness'],
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function extractDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

function findVacancyLinks($, baseUrl) {
  const links = [];
  $('a[href]').each((_, el) => {
    const href = $( el).attr('href') || '';
    try {
      const abs = new URL(href, baseUrl).href;
      const domain = extractDomain(abs);
      const baseDomain = extractDomain(baseUrl);
      if (domain === baseDomain && VACANCY_PATH_PATTERNS.some((p) => p.test(abs))) {
        links.push(abs);
      }
    } catch {}
  });
  return [...new Set(links)].slice(0, 2);
}

function detectATS(html) {
  for (const [name, pattern] of Object.entries(ATS_SIGNATURES)) {
    if (pattern.test(html)) return name;
  }
  return null;
}

function countVacancyIndicators(text) {
  // Count job-like blocks: patterns that suggest individual vacancies
  const patterns = [
    /\bvacature\b/gi,
    /\bfunctie\b/gi,
    /\bjob opening/gi,
    /\bwe (zijn op zoek|zoeken)/gi,
    /\bopen position/gi,
    /\bstellenangebot/gi,
  ];
  let count = 0;
  for (const p of patterns) {
    const matches = text.match(p);
    if (matches) count += matches.length;
  }
  return Math.min(count, 50); // cap for scoring
}

function detectJobCategories(text) {
  const lower = text.toLowerCase();
  const found = [];
  for (const [label, keywords] of Object.entries(JOB_CATEGORY_MAP)) {
    if (keywords.some((kw) => lower.includes(kw))) found.push(label);
  }
  return found;
}

function detectHREmail(emails = [], text = '') {
  // Prefer emails with hr/jobs/careers/recruitment prefix
  const hrPattern = /^(hr|jobs?|careers?|recruitment|vacatures?|werk|talent|people)\b/i;
  const hrEmail = emails.find((e) => hrPattern.test(e.split('@')[0]));
  if (hrEmail) return hrEmail;

  // Fallback: look for email near HR-related text
  const hrNearby = text.match(/(?:hr|recruitment|vacature)[^\n]{0,80}([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
  return hrNearby?.[1] ?? null;
}

// ─── Sector query map (module-level so it can be exposed as sectors list) ────

const RECRUITMENT_QUERIES = {
  // ── B2B / industrie ──────────────────────────────────────────────────────
  logistiek:           ['logistiek bedrijf "werken bij"', 'transportbedrijf "werken bij"', 'magazijn bedrijf vacatures'],
  bouwmaterialen:      ['bouwbedrijf "werken bij"', 'aannemersbedrijf vacatures', 'bouwmaterialen groothandel "werken bij"'],
  voedsel_groothandel: ['voedsel groothandel "werken bij"', 'food bedrijf vacatures'],
  metaal_staal:        ['metaalbedrijf "werken bij"', 'staalhandel vacatures'],
  chemie:              ['chemiebedrijf "werken bij"', 'farmaceutisch bedrijf vacatures'],
  techniek:            ['technisch bedrijf "werken bij"', 'installatiebedrijf vacatures'],
  schoonmaak:          ['schoonmaakbedrijf "werken bij"', 'facilitair bedrijf vacatures'],
  papier_verpakking:   ['verpakkingsbedrijf "werken bij"', 'papiergroothandel vacatures'],

  // ── Horeca ───────────────────────────────────────────────────────────────
  horeca:              ['restaurant "werken bij"', 'hotel "werken bij"', 'café "werken bij"', 'cateringbedrijf vacatures'],

  // ── Leisure / vrije tijd ─────────────────────────────────────────────────
  leisure:             ['sportschool "werken bij"', 'fitnesscentrum vacatures', 'pretpark "werken bij"', 'bioscoop vacatures', 'theater "werken bij"', 'wellness "werken bij"'],

  // ── Zorg / health ────────────────────────────────────────────────────────
  zorg:                ['tandartspraktijk "werken bij"', 'fysiotherapiepraktijk vacatures', 'huisartsenpraktijk "werken bij"', 'apotheek vacatures', 'dierenartspraktijk "werken bij"', 'opticiën vacatures'],

  // ── Retail / detailhandel ────────────────────────────────────────────────
  retail:              ['winkel "werken bij"', 'supermarkt "werken bij"', 'kledingwinkel vacatures', 'bouwmarkt "werken bij"', 'kapper "werken bij"'],

  // ── Lokaal / diversen ────────────────────────────────────────────────────
  lokaal:              ['garage "werken bij"', 'autogarage vacatures', 'wasserij "werken bij"', 'drukkerij vacatures', 'evenementenbureau "werken bij"'],
};

// Human-readable labels for the frontend ConfigPanel
const SECTOR_LABELS = {
  logistiek:           'Logistiek & Transport',
  bouwmaterialen:      'Bouw & Materialen',
  voedsel_groothandel: 'Voedsel Groothandel',
  metaal_staal:        'Metaal & Staal',
  chemie:              'Chemie & Farma',
  techniek:            'Techniek & Industrie',
  schoonmaak:          'Schoonmaak & Facilitair',
  papier_verpakking:   'Papier & Verpakking',
  horeca:              'Horeca (restaurant, hotel, café)',
  leisure:             'Leisure (sport, wellness, theater)',
  zorg:                'Zorg & Health (tandarts, fysiotherapie)',
  retail:              'Retail & Detailhandel',
  lokaal:              'Lokaal & Diversen (garage, kapper)',
};

// ─── Main exports ─────────────────────────────────────────────────────────────

const RecruitmentAnalyzer = {
  /** Available sectors for the ConfigPanel */
  sectors: Object.entries(RECRUITMENT_QUERIES).map(([key, queries]) => ({
    key,
    label: SECTOR_LABELS[key] ?? key,
    queries,
  })),

  /**
   * Fetches vacancy pages for extra text + ATS detection.
   * Called by the scraper BEFORE analyze(), so the text is enriched.
   */
  async fetchExtra(baseUrl, fetchFn) {
    let extraText = '';
    let extraData = { jobPageUrl: null, atsDetected: null, rawHtml: '' };

    let $homepage;
    try {
      const html = await fetchFn(baseUrl, 6_000);
      $homepage = cheerio.load(html);
      extraData.atsDetected = detectATS(html);
    } catch {
      return { extraText, extraData };
    }

    const vacancyLinks = findVacancyLinks($homepage, baseUrl);
    if (!vacancyLinks.length) return { extraText, extraData };

    extraData.jobPageUrl = vacancyLinks[0];

    for (const link of vacancyLinks) {
      try {
        const html = await fetchFn(link, 10_000);
        const $page = cheerio.load(html);
        const text = $page('body').text().replace(/\s+/g, ' ');
        extraText += ' ' + text;
        if (!extraData.atsDetected) extraData.atsDetected = detectATS(html);
        extraData.rawHtml += html.slice(0, 20_000); // cap
      } catch {}
    }

    return { extraText, extraData };
  },

  /** @returns {{ score: number, analysis_data: object }} */
  analyze({ text, url, extraData = {}, emails = [] }) {
    const lower = text.toLowerCase();

    // 1. Vacancy presence (35 pts)
    const hasVacancyPage = !!extraData.jobPageUrl;
    const vacancyPresenceScore = hasVacancyPage ? 35 : 0;

    // 2. Vacancy count (25 pts)
    const rawCount = countVacancyIndicators(text);
    let vacancyCountScore = 0;
    if (rawCount >= 10) vacancyCountScore = 25;
    else if (rawCount >= 5) vacancyCountScore = 18;
    else if (rawCount >= 2) vacancyCountScore = 10;
    else if (rawCount >= 1) vacancyCountScore = 5;

    // 3. Growth signals (20 pts)
    const growthHits = GROWTH_SIGNALS.filter((s) => lower.includes(s));
    let growthScore = 0;
    if (growthHits.length >= 3) growthScore = 20;
    else if (growthHits.length === 2) growthScore = 14;
    else if (growthHits.length === 1) growthScore = 8;

    // 4. HR contact (10 pts)
    const hrEmail = detectHREmail(emails, text);
    const hrScore = hrEmail ? 10 : 0;

    // 5. ATS detected (10 pts)
    const atsScore = extraData.atsDetected ? 10 : 0;

    const score = Math.min(100,
      vacancyPresenceScore + vacancyCountScore + growthScore + hrScore + atsScore
    );

    const jobCategories = detectJobCategories(text);

    return {
      score,
      analysis_data: {
        score,
        vacanciesCount:   rawCount,
        jobPageUrl:       extraData.jobPageUrl ?? null,
        jobCategories,
        hrEmail:          hrEmail ?? null,
        atsDetected:      extraData.atsDetected ?? null,
        growthSignals:    growthHits.slice(0, 5),
        breakdown: {
          vacancyPresence: { score: vacancyPresenceScore, max: 35 },
          vacancyCount:    { score: vacancyCountScore,    max: 25 },
          growth:          { score: growthScore,          max: 20 },
          hrContact:       { score: hrScore,              max: 10 },
          ats:             { score: atsScore,             max: 10 },
        },
      },
    };
  },

  generateQueries(config) {
    const COUNTRY_SUFFIX = { NL: 'Nederland', BE: 'België', DE: 'Deutschland' };

    const sectorKeys = config.sectorKeys?.length
      ? config.sectorKeys.filter((k) => RECRUITMENT_QUERIES[k])
      : Object.keys(RECRUITMENT_QUERIES);

    const countryKeys = config.countryKeys?.length ? config.countryKeys : ['NL'];

    const queries = [];
    for (const sk of sectorKeys) {
      for (const ck of countryKeys) {
        const suffix = COUNTRY_SUFFIX[ck] ?? ck;
        const tld    = ck === 'NL' ? 'site:.nl' : ck === 'BE' ? 'site:.be' : 'site:.de';
        for (const q of RECRUITMENT_QUERIES[sk]) {
          queries.push({
            query:      `${q} ${suffix} ${tld}`,
            sector:     sk,
            sectorKey:  sk,
            country:    suffix,
            countryKey: ck,
          });
        }
      }
    }
    return queries;
  },
};

export default RecruitmentAnalyzer;
