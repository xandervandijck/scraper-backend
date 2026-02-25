/**
 * Scraper Engine
 *
 * Flow:
 *   1. Puppeteer DDG search → extract result URLs  (HTTP fallback if disabled)
 *   2. Filter noise domains + already-visited
 *   3. Concurrently scrape each site (max N concurrent)
 *   4. Extract: company name, email, phone, address, description
 *   5. Analyse ERP fit score
 *   6. Validate email (optional)
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import ERPAnalyzer from './analyzers/erpAnalyzer.js';
import { validateEmail } from './emailValidator.js';
import cache from './cache.js';
import { searchWithPuppeteer } from './searchPuppeteer.js';

// ─── Constants ─────────────────────────────────────────────────────────────

const DDG_URL = 'https://html.duckduckgo.com/html/';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
];

const NOISE_DOMAINS = new Set([
  'facebook.com', 'twitter.com', 'x.com', 'linkedin.com', 'instagram.com', 'youtube.com',
  'wikipedia.org', 'amazon.com', 'amazon.de', 'amazon.nl', 'ebay.com', 'ebay.nl',
  'shopify.com', 'indiamart.com', 'uline.com', 'europages.co.uk', 'ensun.io',
  'kompass.com', 'gamma.nl', 'makro.nl', 'staples.nl', 'lyreco.com', 'bidfood.nl',
  'merkandi.nl', 'google.com', 'google.nl', 'google.de', 'google.be',
  'duckduckgo.com', 'bing.com', 'yahoo.com', 'yelp.com', 'trustpilot.com',
  'kvk.nl', 'glassdoor.com', 'indeed.com', 'reddit.com', 'pinterest.com',
  // Job boards & recruitment aggregators (noise for recruitment use case)
  'monsterboard.nl', 'nationale-vacaturebank.nl', 'jobbird.com', 'werkzoeken.nl',
  'careernet.nl', 'intermediair.nl', 'werken.nl', 'vacatures.nl', 'jobrapido.com',
  'jooble.org', 'totaljobs.com', 'jobs.nl', 'jobtiger.nl', 'uitzendbureau.nl',
  'tempo-team.nl', 'randstad.nl', 'manpower.nl', 'adecco.nl', 'yacht.nl',
  'undutchables.nl', 'pagegroup.nl', 'michaelpage.nl', 'heidrick.com',
  'stepstone.de', 'xing.com', 'monster.de', 'jobware.de', 'stepstone.be',
  'worldwidejanitor.com', 'hillyard.com', 'zogics.com', 'wholesalecleaning.co.uk',
  'shell.nl', 'ikea.com', 'booking.com', 'tripadvisor.com',
  'bol.com', 'coolblue.nl', 'wehkamp.nl',
  // Content/app platforms
  'substack.com', 'medium.com', 'wordpress.com', 'wix.com', 'squarespace.com',
  'apple.com', 'microsoft.com', 'play.google.com',
  'github.com', 'stackoverflow.com', 'npmjs.com',
]);

const TLD_WHITELIST = new Set([
  '.nl', '.be', '.de', '.com', '.eu', '.net', '.org', '.biz', '.info',
]);

const EMAIL_BLACKLIST_REGEX = /\.(png|jpg|gif|svg|woff|css|js|ico)$/i;

// ─── Utility helpers ────────────────────────────────────────────────────────

function randomAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function isNoiseDomain(domain) {
  if (!domain) return true;
  if (NOISE_DOMAINS.has(domain)) return true;
  // Check partial match (e.g. subdomain.noisesite.com)
  for (const noise of NOISE_DOMAINS) {
    if (domain.endsWith(`.${noise}`) || domain === noise) return true;
  }
  return false;
}

function hasSupportedTLD(url) {
  try {
    const hostname = new URL(url).hostname;
    return [...TLD_WHITELIST].some((tld) => hostname.endsWith(tld));
  } catch {
    return false;
  }
}

// ─── Concurrency Limiter ────────────────────────────────────────────────────

class ConcurrencyLimiter {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }

  run(fn) {
    return new Promise((resolve, reject) => {
      const execute = async () => {
        this.current++;
        try {
          resolve(await fn());
        } catch (err) {
          reject(err);
        } finally {
          this.current--;
          if (this.queue.length > 0) this.queue.shift()();
        }
      };

      if (this.current < this.max) {
        execute();
      } else {
        this.queue.push(execute);
      }
    });
  }
}

// ─── Search (Puppeteer primary, HTTP fallback) ──────────────────────────────

/**
 * Primary: Puppeteer
 * Fallback: axios POST to DDG HTML endpoint (used when usePuppeteer=false or on error)
 */
export async function searchDDG(query, { maxResults = 15, usePuppeteer = true, onProgress } = {}) {
  if (usePuppeteer) {
    try {
      const result = await searchWithPuppeteer(query, { maxResults, onProgress });
      if (result.urls.length > 0 || result.blocked) return result.urls;
      // Zero results but not blocked: fall through to HTTP fallback
    } catch (err) {
      console.warn(`[Search] Puppeteer error for "${query}": ${err.message} — falling back to HTTP`);
    }
  }

  // HTTP fallback
  return searchDuckDuckGoHTTP(query, maxResults);
}

async function searchDuckDuckGoHTTP(query, maxResults = 15) {
  try {
    const response = await axios.post(
      'https://html.duckduckgo.com/html/',
      new URLSearchParams({ q: query, kl: 'nl-nl' }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': randomAgent(),
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8',
        },
        timeout: 20_000,
      }
    );

    const $ = cheerio.load(response.data);
    const urls = [];

    $('a.result__a').each((_, el) => {
      const href = $(el).attr('href') || '';
      const url = extractDDGUrl(href);
      if (url) urls.push(url);
    });

    if (urls.length === 0) {
      $('.result__url').each((_, el) => {
        let text = $(el).text().trim();
        if (text && !text.startsWith('http')) text = 'https://' + text;
        if (text) urls.push(text);
      });
    }

    return [...new Set(urls)]
      .filter((u) => hasSupportedTLD(u))
      .slice(0, maxResults);
  } catch (err) {
    if (err.response?.status === 429) await sleep(30_000);
    return [];
  }
}

function extractDDGUrl(href) {
  if (!href) return null;
  try {
    const full = href.startsWith('//') ? 'https:' + href : href;
    const url = new URL(full);
    const uddg = url.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
    if (url.protocol === 'https:' || url.protocol === 'http:') return full;
  } catch {}
  return null;
}

// ─── Email extraction ────────────────────────────────────────────────────────

const EMAIL_REGEX = /[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/g;

const SERVICE_EMAIL_PATTERN = /(@|\.)(?:sentry|ingest|bugsnag|datadog|cloudflare|amazonaws|googleapis|jsdelivr|unpkg|gravatar|schema\.org|wp\.com)/i;

function extractEmails(text) {
  const matches = (text.match(EMAIL_REGEX) ?? [])
    .map((e) => e.toLowerCase())
    .filter((e) => {
      if (EMAIL_BLACKLIST_REGEX.test(e)) return false;
      if (e.includes('..')) return false;
      if (e.endsWith('.')) return false;
      if (SERVICE_EMAIL_PATTERN.test(e)) return false;
      // Reject suspiciously long local parts (obfuscated IDs)
      const local = e.split('@')[0];
      if (local.length > 40) return false;
      return true;
    });

  // Deduplicate
  return [...new Set(matches)];
}

function rankEmails(emails, domain) {
  // Prefer domain-matching emails
  const domainEmails = emails.filter((e) => e.endsWith(`@${domain}`) || e.includes(`@${domain.replace(/^www\./, '')}`));
  const genericOrder = ['info@', 'contact@', 'sales@', 'office@', 'admin@'];
  const sorted = [
    ...domainEmails.filter((e) => genericOrder.some((g) => e.startsWith(g))),
    ...domainEmails.filter((e) => !genericOrder.some((g) => e.startsWith(g))),
    ...emails.filter((e) => !domainEmails.includes(e)),
  ];
  return sorted;
}

// ─── Phone extraction ────────────────────────────────────────────────────────

const PHONE_PATTERNS = [
  /(?:\+31|0031|0)[\s.-]?(?:\d[\s.-]?){8,9}/g,   // NL
  /(?:\+32|0032|0)[\s.-]?(?:\d[\s.-]?){8,9}/g,   // BE
  /(?:\+49|0049|0)[\s.-]?(?:\d[\s.-]?){9,10}/g,  // DE
  /\+\d{1,3}[\s.-]?\d{4,14}/g,                   // Generic international
];

function extractPhone(text) {
  for (const pattern of PHONE_PATTERNS) {
    const matches = text.match(pattern);
    if (matches && matches.length > 0) {
      return matches[0].trim().replace(/\s+/g, ' ');
    }
  }
  return null;
}

// ─── Company info extraction ─────────────────────────────────────────────────

function extractCompanyInfo($, url) {
  const domain = extractDomain(url) ?? url;

  // Company name: try og:site_name, title, h1
  const ogSiteName = $('meta[property="og:site_name"]').attr('content');
  const title = $('title').first().text().trim();
  const h1 = $('h1').first().text().trim();

  let companyName =
    ogSiteName ||
    (title.length < 80 ? title.split(/[-|–—]/)[0].trim() : '') ||
    h1.substring(0, 80) ||
    domain;

  // Description
  const metaDesc =
    $('meta[name="description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content') ||
    '';

  // Address heuristic: look for address-like text
  const addressCandidates = [];
  $('[itemtype*="PostalAddress"], address, .address, .contact-info, [class*="adres"]').each((_, el) => {
    const text = $(el).text().trim().replace(/\s+/g, ' ');
    if (text.length > 10 && text.length < 200) addressCandidates.push(text);
  });

  return {
    companyName: companyName.substring(0, 100),
    description: metaDesc.substring(0, 300),
    address: addressCandidates[0]?.substring(0, 150) ?? '',
  };
}

// ─── Site scraping ───────────────────────────────────────────────────────────

async function fetchPage(url, timeoutMs = 12_000) {
  const response = await axios.get(url, {
    headers: {
      'User-Agent': randomAgent(),
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8,de;q=0.7',
    },
    timeout: timeoutMs,
    maxRedirects: 5,
    validateStatus: (s) => s < 400,
  });
  return response.data;
}

const CONTACT_PAGE_PATTERNS = [
  /\/(contact|over-ons|about|kontakt|kontaktieren|uber-uns|over|info)[/-]?$/i,
];

function findContactLinks($, baseUrl) {
  const links = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    try {
      const abs = new URL(href, baseUrl).href;
      if (CONTACT_PAGE_PATTERNS.some((p) => p.test(abs))) {
        const domain = extractDomain(abs);
        const baseDomain = extractDomain(baseUrl);
        if (domain === baseDomain) links.push(abs);
      }
    } catch {}
  });
  return [...new Set(links)].slice(0, 2);
}

export async function scrapeSite(url, { emailValidation = true, deepValidation = false, analyzer = ERPAnalyzer } = {}) {
  const domain = extractDomain(url);
  if (!domain || isNoiseDomain(domain) || cache.isVisited(domain)) return null;

  cache.markVisited(domain);

  let allText = '';
  let $homepage;

  // Fetch homepage
  try {
    const html = await fetchPage(url);
    $homepage = cheerio.load(html);
    allText += $homepage('body').text().replace(/\s+/g, ' ');
  } catch {
    return null; // Homepage fail → skip domain
  }

  // Try contact page for more emails
  const contactLinks = findContactLinks($homepage, url);
  for (const link of contactLinks) {
    try {
      const html = await fetchPage(link, 8_000);
      const $contact = cheerio.load(html);
      allText += ' ' + $contact('body').text().replace(/\s+/g, ' ');
    } catch {}
    await sleep(500);
  }

  // Extract data
  const emails = rankEmails(extractEmails(allText), domain);
  const phone = extractPhone(allText);
  const { companyName, description, address } = extractCompanyInfo($homepage, url);
  // Analyzer: fetchExtra (e.g. recruitment crawls /vacatures), then analyze
  const { extraText = '', extraData = {} } = await (analyzer.fetchExtra?.(url, fetchPage) ?? Promise.resolve({ extraText: '', extraData: {} }));
  if (extraText) allText += ' ' + extraText;
  const analysis = analyzer.analyze({ text: allText, url, domain, extraData, emails });

  const primaryEmail = emails[0] ?? null;

  // Email validation
  let emailValid = false;
  let emailValidationScore = 0;
  let emailValidationReason = 'not_checked';

  if (primaryEmail && emailValidation) {
    try {
      const result = await validateEmail(primaryEmail, { deepValidation, timeoutMs: 5_000 });
      emailValid = result.valid;
      emailValidationScore = result.score;
      emailValidationReason = result.reason;
    } catch {
      emailValidationReason = 'validation_error';
    }
  } else if (!primaryEmail) {
    emailValidationReason = 'no_email_found';
  }

  return {
    companyName,
    website: url,
    domain,
    email: primaryEmail,
    allEmails: emails.slice(0, 5),
    phone,
    address,
    description,
    score: analysis.score,
    analysisData: analysis.analysis_data,
    emailValid,
    emailValidationScore,
    emailValidationReason,
    foundAt: new Date().toISOString(),
  };
}

// ─── Scraper Engine ──────────────────────────────────────────────────────────

export class ScraperEngine {
  constructor({
    concurrency = 5,
    minScore = 50,
    emailValidation = true,
    deepValidation = false,
    usePuppeteer = true,
    analyzer = ERPAnalyzer,
  } = {}) {
    this.concurrency = concurrency;
    this.minScore = minScore;
    this.emailValidation = emailValidation;
    this.deepValidation = deepValidation;
    this.usePuppeteer = usePuppeteer;
    this.analyzer = analyzer;
    this.limiter = new ConcurrencyLimiter(concurrency);
    this.stopRequested = false;
    this.leads = [];
    this.processedDomains = new Set();
  }

  requestStop() {
    this.stopRequested = true;
  }

  async runQuery(querySpec, { sector, country, onDomainFound, onLeadFound, onLog, onError, onSearchProgress } = {}) {
    if (this.stopRequested) return;

    const source = this.usePuppeteer ? 'Puppeteer' : 'HTTP';
    onLog?.('info', `[${source}] Zoeken: ${querySpec.query}`);

    const urls = await searchDDG(querySpec.query, {
      maxResults: 20,
      usePuppeteer: this.usePuppeteer,
      onProgress: (info) => onSearchProgress?.(info),
    });

    onLog?.('info', `  → ${urls.length} URLs gevonden`);

    const newUrls = urls.filter((u) => {
      const d = extractDomain(u);
      return d && !this.processedDomains.has(d) && !isNoiseDomain(d);
    });

    onDomainFound?.(newUrls.length);

    // Small delay between search and scraping
    await sleep(500 + Math.random() * 500);

    const tasks = newUrls.map((url) =>
      this.limiter.run(async () => {
        if (this.stopRequested) return;

        const domain = extractDomain(url);
        if (!domain || this.processedDomains.has(domain)) return;
        this.processedDomains.add(domain);

        onLog?.('info', `  Scraping: ${domain}`);

        try {
          const result = await scrapeSite(url, {
            emailValidation: this.emailValidation,
            deepValidation: this.deepValidation,
            analyzer: this.analyzer,
          });

          if (!result) {
            onError?.();
            return;
          }

          if (result.score < this.minScore) {
            onLog?.('info', `  Skip ${domain}: score ${result.score} < ${this.minScore}`);
            return;
          }

          const lead = { ...result, sector, country };
          this.leads.push(lead);
          onLeadFound?.(lead);
          onLog?.('success', `  Lead: ${result.companyName} (${domain}) — score: ${result.score}`);
        } catch (err) {
          onLog?.('warn', `  Fout bij ${domain}: ${err.message}`);
          onError?.();
        }
      })
    );

    await Promise.allSettled(tasks);
  }
}

export default ScraperEngine;
