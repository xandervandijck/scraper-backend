'use strict';

/**
 * Puppeteer Search Engine for DuckDuckGo
 *
 * Provides:
 *   - Singleton browser with auto-restart on crash
 *   - Page pool (reuse pages, never create more than maxPages)
 *   - Adaptive delay on rate-limit signals
 *   - Multi-selector URL extraction with fallbacks
 *   - Block/CAPTCHA detection with retry
 *   - Optional HTTP fallback if Puppeteer fails
 */

const puppeteer = require('puppeteer');

const NOISE_DOMAINS = new Set([
  'facebook.com', 'twitter.com', 'x.com', 'linkedin.com', 'instagram.com',
  'youtube.com', 'wikipedia.org', 'amazon.com', 'amazon.de', 'amazon.nl',
  'ebay.com', 'ebay.nl', 'google.com', 'google.nl', 'google.de', 'google.be',
  'duckduckgo.com', 'bing.com', 'yahoo.com', 'yelp.com', 'trustpilot.com',
  'kvk.nl', 'glassdoor.com', 'indeed.com', 'reddit.com', 'pinterest.com',
  'shopify.com', 'indiamart.com', 'uline.com', 'europages.co.uk', 'ensun.io',
  'kompass.com', 'gamma.nl', 'makro.nl', 'staples.nl', 'lyreco.com',
  'bidfood.nl', 'merkandi.nl', 'shell.nl', 'ikea.com', 'bol.com',
  'booking.com', 'tripadvisor.com', 'coolblue.nl', 'wehkamp.nl',
  'substack.com', 'medium.com', 'wordpress.com', 'wix.com', 'squarespace.com',
  'apple.com', 'microsoft.com', 'play.google.com',
  'github.com', 'stackoverflow.com', 'npmjs.com',
  'horeca-job.nl', 'horecajob.nl', 'nationalehorecagids.nl', 'werkenbijappel.nl',
  'werkenbijvitam.nl', 'werkenbij.nl', 'bijbaan.nl', 'studentjob.nl',
  'youngcapital.nl', 'jobalert.nl', 'jobsonline.nl', 'werk.nl',
]);

const AGENCY_DOMAIN_RE = /\b(uitzend(bureau|krachten?|er)?|werving(-en-)?selectie|detacher(ing)?|headhunt(er|ing)?|payroll|recruitment(bureau|agency)?|personeels(bureau|diensten|advies)?|flexwerk|staffing|interim(bureau|management)?|arbeidsbemiddeling|baancoach|jobcoach|careercoach|talentpool|placementbureau|horeca-?job|vacature|vacatures|jobs?|jobboard|werkenbij[a-z0-9-]*)\b/i;

const RESULT_SELECTORS = [
  'a[data-testid="result-title-a"]',
  'article[data-testid="result"] h2 a',
  'article h2 a[href]',
  '.react-results--main article a[href]',
  '#links .result .result__a',
  '#links .result a.result__a',
  'h2 > a[href^="http"]',
];

const BLOCK_SIGNALS = [
  'captcha', 'unusual traffic', 'blocked', 'access denied',
  'too many requests', 'robot', 'automated', 'bot check',
];

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--disable-gpu',
  '--window-size=1280,800',
];

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function isNoiseDomain(url) {
  const d = extractDomain(url);
  if (!d) return true;
  for (const noise of NOISE_DOMAINS) {
    if (d === noise || d.endsWith(`.${noise}`)) return true;
  }
  if (AGENCY_DOMAIN_RE.test(d)) return true;
  return false;
}

function resolveDDGRedirect(href) {
  try {
    const url = new URL(href);
    if (
      (url.hostname.includes('duckduckgo.com') || href.startsWith('/l/')) &&
      url.searchParams.has('uddg')
    ) {
      return decodeURIComponent(url.searchParams.get('uddg'));
    }
    return href;
  } catch {
    return href;
  }
}

function filterURLs(hrefs) {
  const seen = new Set();
  const out = [];
  for (const raw of hrefs) {
    const href = resolveDDGRedirect(raw);
    if (!href || isNoiseDomain(href)) continue;
    try {
      const url = new URL(href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      if (url.hostname.includes('duckduckgo.com')) continue;
      const domain = extractDomain(href);
      if (!domain || seen.has(domain)) continue;
      seen.add(domain);
      out.push(href);
    } catch {}
  }
  return out;
}

class PagePool {
  constructor(maxSize = 5) {
    this.maxSize = maxSize;
    this.available = [];
    this.waiters = [];
    this.total = 0;
  }

  async acquire(browser) {
    while (this.available.length > 0) {
      const page = this.available.pop();
      if (!page.isClosed()) return page;
      this.total--;
    }

    if (this.total < this.maxSize) {
      this.total++;
      try {
        const page = await browser.newPage();
        await setupPage(page);
        return page;
      } catch (err) {
        this.total--;
        throw err;
      }
    }

    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  release(page) {
    if (this.waiters.length > 0) {
      const { resolve } = this.waiters.shift();
      resolve(page);
    } else {
      this.available.push(page);
    }
  }

  rejectAll(err) {
    for (const { reject } of this.waiters) reject(err);
    this.waiters = [];
  }

  async drain() {
    this.rejectAll(new Error('Pool drained'));
    for (const page of this.available) {
      await page.close().catch(() => {});
    }
    this.available = [];
    this.total = 0;
  }
}

async function setupPage(page) {
  await page.setUserAgent(USER_AGENT);
  await page.setViewport({ width: 1280, height: 800 });
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'nl-NL,nl;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  });

  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const type = req.resourceType();
    if (['image', 'font', 'media', 'stylesheet'].includes(type)) {
      req.abort();
    } else {
      req.continue();
    }
  });
}

class BrowserManager {
  constructor() {
    this._browser = null;
    this._pool = null;
    this._launching = null;
    this._delay = 1500;
    this._consecutiveBlocks = 0;
  }

  async _launch() {
    const browserlessToken = process.env.BROWSERLESS_TOKEN;
    const browser = browserlessToken
      ? await puppeteer.connect({
          browserWSEndpoint: `wss://chrome.browserless.io?token=${browserlessToken}`,
        })
      : await puppeteer.launch({ headless: true, args: LAUNCH_ARGS });

    browser.on('disconnected', () => {
      console.warn('[Puppeteer] Browser disconnected, will relaunch on next use');
      this._pool?.drain().catch(() => {});
      this._browser = null;
      this._pool = null;
      this._launching = null;
    });

    this._browser = browser;
    this._pool = new PagePool(5);
    return browser;
  }

  async getBrowser() {
    if (this._browser?.isConnected()) return this._browser;
    if (this._launching) return this._launching;
    this._launching = this._launch().finally(() => { this._launching = null; });
    return this._launching;
  }

  async getPage() {
    const browser = await this.getBrowser();
    return this._pool.acquire(browser);
  }

  releasePage(page) {
    if (!page.isClosed()) {
      page.goto('about:blank').catch(() => {});
    }
    this._pool?.release(page);
  }

  recordBlock() {
    this._consecutiveBlocks++;
    this._delay = Math.min(60_000, this._delay * 2);
  }

  recordSuccess() {
    this._consecutiveBlocks = 0;
    this._delay = Math.max(1500, this._delay * 0.9);
  }

  get currentDelay() {
    return this._delay;
  }

  get isBlocked() {
    return this._consecutiveBlocks >= 3;
  }

  async close() {
    await this._pool?.drain();
    await this._browser?.close().catch(() => {});
    this._browser = null;
    this._pool = null;
    this._launching = null;
  }

  get isRunning() {
    return !!this._browser?.isConnected();
  }
}

const browserManager = new BrowserManager();

async function detectBlock(page) {
  try {
    const [title, bodyText] = await Promise.all([
      page.title(),
      page.evaluate(() => document.body?.innerText?.substring(0, 1000) ?? ''),
    ]);
    const combined = (title + ' ' + bodyText).toLowerCase();
    return BLOCK_SIGNALS.some((signal) => combined.includes(signal));
  } catch {
    return false;
  }
}

async function waitForResults(page) {
  for (const selector of RESULT_SELECTORS) {
    try {
      await page.waitForSelector(selector, { timeout: 4000 });
      return selector;
    } catch {}
  }

  await page.evaluate(() => window.scrollBy(0, 500)).catch(() => {});
  await sleep(800);

  for (const selector of RESULT_SELECTORS) {
    try {
      const el = await page.$(selector);
      if (el) return selector;
    } catch {}
  }

  return null;
}

async function extractURLs(page, maxResults) {
  for (const selector of RESULT_SELECTORS) {
    try {
      const hrefs = await page.$$eval(selector, (els) =>
        els.map((el) => el.href).filter(Boolean)
      );
      const filtered = filterURLs(hrefs);
      if (filtered.length > 0) return filtered.slice(0, maxResults);
    } catch {}
  }

  try {
    const allHrefs = await page.$$eval('a[href]', (els) =>
      els.map((el) => el.href).filter((h) => h.startsWith('http'))
    );
    return filterURLs(allHrefs).slice(0, maxResults);
  } catch {
    return [];
  }
}

/**
 * @param {string} query
 * @param {{
 *   maxResults?: number,
 *   onProgress?: Function,
 *   retryCount?: number,
 *   isStopped?: () => boolean
 * }} options
 * @returns {Promise<{ urls: string[], blocked: boolean, source: string }>}
 */
async function searchWithPuppeteer(query, {
  maxResults = 15,
  onProgress,
  retryCount = 0,
  isStopped = () => false,
} = {}) {
  let page;
  try {
    if (isStopped()) return { urls: [], blocked: false, source: 'puppeteer' };

    page = await browserManager.getPage();

    if (isStopped()) { browserManager.releasePage(page); page = null; return { urls: [], blocked: false, source: 'puppeteer' }; }

    const searchUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}&kl=nl-nl&ia=web`;

    await page.goto(searchUrl, {
      waitUntil: 'networkidle2',
      timeout: 25_000,
    });

    if (isStopped()) return { urls: [], blocked: false, source: 'puppeteer' };

    const blocked = await detectBlock(page);
    if (blocked) {
      browserManager.recordBlock();
      const delay = 8_000 + retryCount * 12_000;

      if (retryCount < 2 && !isStopped()) {
        console.warn(`[Puppeteer] Blocked on "${query}", retry ${retryCount + 1} after ${delay}ms`);
        browserManager.releasePage(page);
        page = null;
        await sleep(delay);
        return searchWithPuppeteer(query, { maxResults, onProgress, retryCount: retryCount + 1, isStopped });
      }

      onProgress?.({ query, resultsFound: 0, blocked: true, source: 'puppeteer' });
      return { urls: [], blocked: true, source: 'puppeteer' };
    }

    if (isStopped()) return { urls: [], blocked: false, source: 'puppeteer' };

    await waitForResults(page);

    if (isStopped()) return { urls: [], blocked: false, source: 'puppeteer' };

    const urls = await extractURLs(page, maxResults);

    browserManager.recordSuccess();
    onProgress?.({ query, resultsFound: urls.length, blocked: false, source: 'puppeteer' });

    const delayMs = browserManager.currentDelay + Math.random() * 500;
    const step = 200;
    for (let elapsed = 0; elapsed < delayMs && !isStopped(); elapsed += step) {
      await sleep(Math.min(step, delayMs - elapsed));
    }

    return { urls, blocked: false, source: 'puppeteer' };
  } catch (err) {
    onProgress?.({ query, resultsFound: 0, blocked: false, error: err.message, source: 'puppeteer' });
    return { urls: [], blocked: false, source: 'puppeteer', error: err.message };
  } finally {
    if (page) browserManager.releasePage(page);
  }
}

module.exports = { browserManager, searchWithPuppeteer };
