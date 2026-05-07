'use strict';

/**
 * Generic prospecting analyzer.
 */
const cheerio = require('cheerio');

const VACANCY_PATH_PATTERNS = [
  /\/(vacatures?|vacature|jobs?|careers?|werken-bij|werken_bij|werkenbij|hiring|join-us|join_us|karriere|stellenangebote)[/-]?(\?.*)?$/i,
];

const VACANCY_KEYWORDS = [
  'vacature', 'vacatures', 'werken bij', 'we zoeken', 'wij zoeken',
  'job opening', 'careers', 'join our team', 'hiring',
  'stellenangebot', 'karriere',
];

const GROWTH_KEYWORDS = [
  'wij groeien', 'we groeien', 'groeiend', 'uitbreiding', 'nieuwe vestiging',
  'expansion', 'growing', 'fast growing', 'snelgroeiend',
];

const ACTIVITY_KEYWORDS = [
  'nieuws', 'blog', 'events', 'agenda', 'portfolio', 'projecten',
  'actueel', 'updates',
];

const SKIP_TITLE = /^(home|contact|over ons|about|menu|nieuws|blog|vacatures|werken bij|careers|solliciteer|privacy|cookie|faq|lees meer|read more|bekijk|meer informatie)$/i;

const JOB_TITLE_KEYWORDS = /\b(kok|chef|bediening|kelner|serveer|barista|afwasser|keukenhulp|restaurantmanager|horecamedewerker|hotelmedewerker|receptionist|schoonmaker|verkoopmedewerker|monteur|chauffeur|magazijnmedewerker|operator|accountmanager|administratief medewerker|planner|teamleider|manager|medewerker)\b/i;

function cleanText(value, max = 160) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

function findVacancyLinks($, baseUrl) {
  const links = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const label = cleanText($(el).text(), 80).toLowerCase();
    try {
      const abs = new URL(href, baseUrl).href;
      const sameDomain = extractDomain(abs) === extractDomain(baseUrl);
      const looksLikeVacancy =
        VACANCY_PATH_PATTERNS.some((p) => p.test(abs)) ||
        VACANCY_KEYWORDS.some((kw) => label.includes(kw));
      if (sameDomain && looksLikeVacancy) links.push(abs);
    } catch {}
  });
  return [...new Set(links)].slice(0, 3);
}

function extractJobTitles($page) {
  const titles = [];
  const seen = new Set();
  const selectors = [
    '[class*="vacature"] h1,[class*="vacature"] h2,[class*="vacature"] h3,[class*="job"] h1,[class*="job"] h2,[class*="job"] h3',
    'h1,h2,h3,h4',
  ];

  for (const selector of selectors) {
    $page(selector).each((_, el) => {
      const title = cleanText($page(el).text(), 100);
      const key = title.toLowerCase();
      if (title.length >= 4 && JOB_TITLE_KEYWORDS.test(title) && !SKIP_TITLE.test(title) && !seen.has(key)) {
        seen.add(key);
        titles.push(title);
      }
    });
    if (titles.length >= 5) break;
  }

  return titles.slice(0, 10);
}

function extractInlineJobTitles(text) {
  const titles = [];
  const seen = new Set();
  const patterns = [
    /(?:wij zoeken|we zoeken|gezocht|vacature[:\s-]+)\s+([^.!?\n]{4,80})/gi,
    /\b(kok|chef|zelfstandig werkend kok|bediening|medewerker bediening|barista|afwasser|keukenhulp|restaurantmanager|horecamedewerker|receptionist|schoonmaker|verkoopmedewerker|monteur|chauffeur|magazijnmedewerker|operator|accountmanager|administratief medewerker|planner|teamleider)\b/gi,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const raw = cleanText(match[1] ?? match[0], 90);
      if (!raw || !JOB_TITLE_KEYWORDS.test(raw)) continue;
      const title = raw.replace(/^(een|een enthousiaste|een ervaren|voor|naar)\s+/i, '');
      const key = title.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        titles.push(title);
      }
    }
  }

  return titles.slice(0, 10);
}

function keywordHits(text, keywords) {
  const lower = text.toLowerCase();
  return keywords.filter((kw) => lower.includes(kw));
}

function buildQueries(config) {
  const searchTerm = cleanText(config.searchTerm ?? config.query ?? config.keyword ?? config.sector ?? '', 80);
  const location = cleanText(config.location ?? config.city ?? config.region ?? '', 80);
  const country = cleanText(config.country ?? config.countryKey ?? 'NL', 40);

  if (!searchTerm || !location) return [];

  const locale = country.toUpperCase() === 'BE'
    ? { label: 'België', tld: 'site:.be' }
    : country.toUpperCase() === 'DE'
      ? { label: 'Deutschland', tld: 'site:.de' }
      : { label: 'Nederland', tld: 'site:.nl' };

  const base = `${searchTerm} ${location}`;
  return [
    `${base} vacatures ${locale.tld}`,
    `${base} "werken bij" ${locale.tld}`,
    `${base} personeel gezocht ${locale.tld}`,
    `${base} contact email ${locale.tld}`,
    `${base} telefoon website ${locale.tld}`,
    `${base} bedrijf ${locale.label} ${locale.tld}`,
  ].map((query) => ({
    query,
    sector: searchTerm,
    sectorKey: searchTerm.toLowerCase().replace(/\s+/g, '_'),
    country: location,
    countryKey: country.toUpperCase(),
  }));
}

const ProspectingAnalyzer = {
  sectors: [],

  async fetchExtra(baseUrl, fetchFn) {
    let extraText = '';
    const extraData = {
      vacancyLinks: [],
      jobTitles: [],
    };

    let $homepage;
    try {
      const html = await fetchFn(baseUrl, 6_000);
      $homepage = cheerio.load(html);
    } catch {
      return { extraText, extraData };
    }

    const vacancyLinks = findVacancyLinks($homepage, baseUrl);
    extraData.vacancyLinks = vacancyLinks;

    for (const link of vacancyLinks) {
      try {
        const html = await fetchFn(link, 8_000);
        const $page = cheerio.load(html);
        extraText += ' ' + $page('body').text().replace(/\s+/g, ' ');
        extraData.jobTitles.push(...extractJobTitles($page), ...extractInlineJobTitles(text));
      } catch {}
    }

    if (!extraData.jobTitles.length && extraText) {
      extraData.jobTitles.push(...extractInlineJobTitles(extraText));
    }

    extraData.jobTitles = [...new Set(extraData.jobTitles)].slice(0, 10);
    return { extraText, extraData };
  },

  analyze({ text, extraData = {}, emails = [] }) {
    const vacancySignals = keywordHits(text, VACANCY_KEYWORDS);
    const growthSignals = keywordHits(text, GROWTH_KEYWORDS);
    const activitySignals = keywordHits(text, ACTIVITY_KEYWORDS);
    const hasVacancies = extraData.vacancyLinks?.length > 0 || extraData.jobTitles?.length > 0 || vacancySignals.length > 0;

    const score = Math.min(
      100,
      40 +
        (emails.length ? 25 : 0) +
        (hasVacancies ? 15 : 0) +
        (growthSignals.length ? 10 : 0) +
        (activitySignals.length ? 10 : 0),
    );

    let assessment = 'twijfelachtig';
    if (emails.length && score >= 65) assessment = 'interessant';
    if (!emails.length && score < 55) assessment = 'niet_relevant';

    const reason = emails.length
      ? 'Contactgegevens gevonden en bedrijfspagina bevat bruikbare context.'
      : 'Geen emailadres gevonden; handmatige aanvulling nodig voor outreach.';

    return {
      score,
      analysis_data: {
        score,
        status: emails.length ? 'verrijkt' : 'nieuw',
        assessment,
        assessmentReason: reason,
        hasVacancies,
        jobTitles: extraData.jobTitles ?? [],
        vacancyLinks: extraData.vacancyLinks ?? [],
        signals: {
          hiring: vacancySignals.slice(0, 5),
          growth: growthSignals.slice(0, 5),
          activity: activitySignals.slice(0, 5),
        },
      },
    };
  },

  generateQueries(config) {
    return buildQueries(config);
  },
};

module.exports = ProspectingAnalyzer;
