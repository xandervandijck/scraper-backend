'use strict';

/**
 * Recruitment Analyzer
 */
const axios = require('axios');
const cheerio = require('cheerio');

const VACANCY_PATH_PATTERNS = [
  /\/(vacatures?|vacature|jobs?|careers?|werken-bij|werken_bij|werkenbij|stellenangebote|stellen|karriere|jobangebote|hiring|join-us|join_us|offres-emploi|emploi|werken|meewerken|team|ons-team|word-collega|kom-werken|personeel|medewerkers|open-sollicitatie|solliciteer|openstaande-functies|openstaande-vacatures)[/-]?(\?.*)?$/i,
];

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

// Phrases that indicate the site is a staffing agency/intermediary, NOT a real employer
const AGENCY_SIGNALS = [
  // Dutch — "on behalf of our client"
  'namens onze opdrachtgever',
  'in opdracht van onze klant',
  'voor onze opdrachtgever',
  'voor een van onze klanten',
  'voor onze klant in',
  'onze opdrachtgever is',
  // Dutch — explicit self-labelling
  'wij zijn een uitzendbureau',
  'wij zijn een recruitmentbureau',
  'als uitzendbureau',
  'als detacheringsbureau',
  'als recruiter zoeken wij',
  'werving en selectie',
  'wij detacheren',
  'ons uitzendbureau',
  'onze kandidaten',
  'bemiddeling van personeel',
  'arbeidsbemiddeling',
  'uitzendkrachten',
  'uitzendovereenkomst',
  'flexibele schil',
  'tijdelijk personeel voor',
  // German equivalents
  'im auftrag unseres kunden',
  'für unseren kunden suchen',
  'personalvermittlung',
  'zeitarbeit',
  // English equivalents
  'on behalf of our client',
  'for our client we are looking',
  'talent acquisition partner',
  'we are a staffing agency',
  'we are a recruitment agency',
  'permanent and contract recruitment',
];

// Phrases that confirm this is a genuine employer (counter-signals)
const EMPLOYER_SIGNALS = [
  'kom ons team versterken',
  'word collega',
  'ons team bestaat',
  'onze medewerkers',
  'bij ons bedrijf',
  'ons bedrijf is',
  'wij produceren',
  'wij leveren',
  'wij maken',
  'ons product',
  'onze dienstverlening',
  'meer dan .{0,10} jaar ervaring',
  'opgericht in',
  'familiebedrijf',
];

function detectAgency(text, companyName = '') {
  const lower = text.toLowerCase();
  const nameLower = companyName.toLowerCase();

  // Hard indicators in domain/company name
  const nameIsAgency = /uitzend|werving|detacher|staffing|recruitment bureau|personeelsbureau/i.test(nameLower);

  const agencyHits = AGENCY_SIGNALS.filter((s) => lower.includes(s));
  const employerHits = EMPLOYER_SIGNALS.filter((s) => new RegExp(s).test(lower));

  // Score: positive = more agency-like
  let agencyScore = agencyHits.length * 2 + (nameIsAgency ? 10 : 0) - employerHits.length;

  return {
    isAgency: agencyScore >= 2,
    agencyScore,
    agencyHits: agencyHits.slice(0, 3),
  };
}

const GROWTH_SIGNALS = [
  'wij groeien', 'we groeien', 'snelgroeiend', 'groeiend bedrijf',
  'we are growing', 'fast growing', 'rapid growth', 'scale-up',
  'wir wachsen', 'wachsendes unternehmen',
  'nieuwe vestiging', 'uitbreiding', 'expansion', 'erweiterung',
  'investering', 'investment', 'serie a', 'serie b', 'funding',
  'wij zoeken', 'we zijn op zoek', 'kom ons team versterken',
  'join our team', 'join us', 'werde teil',
];

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

function extractDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

function findVacancyLinks($, baseUrl) {
  const links = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
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
  return Math.min(count, 50);
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
  const hrPattern = /^(hr|jobs?|careers?|recruitment|vacatures?|werk|talent|people)\b/i;
  const hrEmail = emails.find((e) => hrPattern.test(e.split('@')[0]));
  if (hrEmail) return hrEmail;

  const hrNearby = text.match(/(?:hr|recruitment|vacature)[^\n]{0,80}([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
  return hrNearby?.[1] ?? null;
}

const SKIP_TITLE = /^(over ons|contact|home|homepage|menu|nieuws|blog|team|service|producten|about|news|jobs|vacatures|werken bij|careers|solliciteer|apply|onze|the |ons |our |wat |wie |hoe |why |when |more |lees |read |meer |alles|frequently|faq|privacy|cookie|partners|volg ons|nieuwsbrief|schrijf je in|meer informatie|bekijk|volg|download|inschrijven|onze diensten|contact op)/i;

function extractVacancyTitles($page) {
  const titles = [];
  const seen = new Set();

  const containerSelectors = [
    '[class*="vacature"]', '[class*="vacancy"]', '[class*="job-item"]',
    '[class*="job-card"]', '[class*="position"]', '[class*="opening"]',
    '[class*="listing-item"]', '[class*="career-item"]',
  ];
  for (const sel of containerSelectors) {
    $page(sel).each((_, el) => {
      const heading = $page(el).find('h1,h2,h3,h4,a').first().text().trim();
      if (heading && heading.length > 3 && heading.length < 100 && !seen.has(heading.toLowerCase())) {
        seen.add(heading.toLowerCase());
        titles.push(heading);
      }
    });
    if (titles.length >= 3) break;
  }

  if (titles.length < 2) {
    $page('h2, h3, h4').each((_, el) => {
      const text = $page(el).text().trim();
      if (
        text.length > 3 && text.length < 100 &&
        !SKIP_TITLE.test(text) &&
        !seen.has(text.toLowerCase())
      ) {
        seen.add(text.toLowerCase());
        titles.push(text);
      }
    });
  }

  return titles.slice(0, 10);
}

const RECRUITMENT_QUERIES = {
  logistiek:           ['logistiek bedrijf "werken bij"', 'transportbedrijf "werken bij"', 'magazijnbedrijf "kom ons team versterken"'],
  bouwmaterialen:      ['bouwbedrijf "werken bij"', 'aannemersbedrijf "werken bij"', 'bouwmaterialen groothandel "werken bij"'],
  voedsel_groothandel: ['voedsel groothandel "werken bij"', 'food producent "werken bij"', 'levensmiddelenbedrijf "wij zoeken"'],
  metaal_staal:        ['metaalbedrijf "werken bij"', 'staalhandel "werken bij"', 'metaalverwerking "wij zoeken"'],
  chemie:              ['chemiebedrijf "werken bij"', 'farmaceutisch bedrijf "werken bij"', 'laboratorium "wij zoeken"'],
  techniek:            ['technisch bedrijf "werken bij"', 'installatiebedrijf "werken bij"', 'machinebouwer "wij zoeken"'],
  schoonmaak:          ['schoonmaakbedrijf "werken bij"', 'facilitair bedrijf "werken bij"', 'reinigingsbedrijf "wij zoeken"'],
  papier_verpakking:   ['verpakkingsbedrijf "werken bij"', 'drukkerij "werken bij"', 'papierbedrijf "wij zoeken"'],
  horeca:              ['restaurant "vacature kok"', 'restaurant "werken bij"', 'hotel "vacature medewerker"', 'cateringbedrijf "werken bij"', 'restaurant "wij zoeken een kok"', 'horecabedrijf "kom ons team versterken"'],
  leisure:             ['sportschool "werken bij"', 'fitnesscentrum "werken bij"', 'wellnesscentrum "wij zoeken"', 'theater "werken bij"'],
  zorg:                ['tandartspraktijk "werken bij"', 'fysiotherapiepraktijk "werken bij"', 'huisartsenpraktijk "wij zoeken"', 'apotheek "werken bij"'],
  retail:              ['winkelketen "werken bij"', 'supermarkt "werken bij"', 'kledingwinkel "werken bij"', 'bouwmarkt "kom ons team versterken"'],
  lokaal:              ['autogarage "werken bij"', 'drukkerij "werken bij"', 'evenementenbureau "wij zoeken"', 'tuincentrum "werken bij"'],
};

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

const RecruitmentAnalyzer = {
  sectors: Object.entries(RECRUITMENT_QUERIES).map(([key, queries]) => ({
    key,
    label: SECTOR_LABELS[key] ?? key,
    queries,
  })),

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
    extraData.vacancyTitles = [];

    for (const link of vacancyLinks) {
      try {
        const html = await fetchFn(link, 10_000);
        const $page = cheerio.load(html);
        const text = $page('body').text().replace(/\s+/g, ' ');
        extraText += ' ' + text;
        if (!extraData.atsDetected) extraData.atsDetected = detectATS(html);
        extraData.rawHtml += html.slice(0, 20_000);
        extraData.vacancyTitles.push(...extractVacancyTitles($page));
      } catch {}
    }

    return { extraText, extraData };
  },

  analyze({ text, url, extraData = {}, emails = [], companyName = '' }) {
    const lower = text.toLowerCase();

    // Agency detection — skip or heavily penalize intermediaries
    const { isAgency, agencyScore, agencyHits } = detectAgency(text, companyName);
    if (isAgency) {
      return {
        score: 0,
        analysis_data: {
          score: 0,
          isAgency: true,
          agencyHits,
          vacanciesCount: 0,
          jobPageUrl: null,
          vacancyTitles: [],
          jobCategories: [],
          hrEmail: null,
          atsDetected: null,
          growthSignals: [],
          breakdown: { agency: { score: -agencyScore, max: 0 } },
        },
      };
    }

    const rawCount = countVacancyIndicators(text);

    // Presence: dedicated vacancy page = 35, strong homepage signals = 20, weak = 10
    const hasVacancyPage = !!extraData.jobPageUrl;
    const vacancyPresenceScore = hasVacancyPage ? 35 : (rawCount >= 4 ? 20 : rawCount >= 1 ? 10 : 0);

    let vacancyCountScore = 0;
    if (rawCount >= 10) vacancyCountScore = 25;
    else if (rawCount >= 5) vacancyCountScore = 18;
    else if (rawCount >= 2) vacancyCountScore = 10;
    else if (rawCount >= 1) vacancyCountScore = 5;

    const growthHits = GROWTH_SIGNALS.filter((s) => lower.includes(s));
    let growthScore = 0;
    if (growthHits.length >= 3) growthScore = 20;
    else if (growthHits.length === 2) growthScore = 14;
    else if (growthHits.length === 1) growthScore = 8;

    const hrEmail = detectHREmail(emails, text);
    const hrScore = hrEmail ? 10 : 0;

    const atsScore = extraData.atsDetected ? 10 : 0;

    const score = Math.min(100,
      vacancyPresenceScore + vacancyCountScore + growthScore + hrScore + atsScore
    );

    const jobCategories = detectJobCategories(text);

    return {
      score,
      analysis_data: {
        score,
        isAgency: false,
        vacanciesCount:   rawCount,
        jobPageUrl:       extraData.jobPageUrl ?? null,
        vacancyTitles:    [...new Set(extraData.vacancyTitles ?? [])].slice(0, 10),
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

module.exports = RecruitmentAnalyzer;
