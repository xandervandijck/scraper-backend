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

import puppeteer from 'puppeteer';

// ─── Constants ────────────────────────────────────────────────────────────────

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
  // Content/app platforms
  'substack.com', 'medium.com', 'wordpress.com', 'wix.com', 'squarespace.com',
  'apple.com', 'microsoft.com', 'play.google.com',
  'github.com', 'stackoverflow.com', 'npmjs.com',
]);

// Try these selectors in order until one yields results
const RESULT_SELECTORS = [
  'a[data-testid="result-title-a"]',
  'article[data-testid="result"] h2 a',
  'article h2 a[href]',
  '.react-results--main article a[href]',
  '#links .result .result__a',
  '#links .result a.result__a',
  'h2 > a[href^="http"]',
];

// Signals that indicate we've been blocked / rate-limited
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

// ─── Utilities ────────────────────────────────────────────────────────────────

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
  return false;
}

function resolveDDGRedirect(href) {
  try {
    const url = new URL(href);
    // DDG redirect: /l/?uddg=<encoded_url>
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

// ─── Page Pool ────────────────────────────────────────────────────────────────

class PagePool {
  constructor(maxSize = 5) {
    this.maxSize = maxSize;
    this.available = [];
    this.waiters = [];
    this.total = 0;
  }

  async acquire(browser) {
    // Try to reuse an idle page
    while (this.available.length > 0) {
      const page = this.available.pop();
      if (!page.isClosed()) return page;
      this.total--;
    }

    // Spawn a new page if under limit
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

    // Wait for a page to be released
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

// ─── Page setup ────────────────────────────────────────────────────────────────

async function setupPage(page) {
  await page.setUserAgent(USER_AGENT);
  await page.setViewport({ width: 1280, height: 800 });
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'nl-NL,nl;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  });

  // Block images, fonts, media → faster page loads
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

// ─── Browser Manager ─────────────────────────────────────────────────────────

class BrowserManager {
  constructor() {
    this._browser = null;
    this._pool = null;
    this._launching = null;
    this._delay = 1500; // adaptive delay between searches
    this._consecutiveBlocks = 0;
  }

  async _launch() {
    const browser = await puppeteer.launch({
      headless: true,
      args: LAUNCH_ARGS,
    });

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
      // Navigate to blank to reset state before reuse
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

export const browserManager = new BrowserManager();

// ─── Block detection ──────────────────────────────────────────────────────────

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

// ─── Result extraction ────────────────────────────────────────────────────────

async function waitForResults(page) {
  for (const selector of RESULT_SELECTORS) {
    try {
      await page.waitForSelector(selector, { timeout: 4000 });
      return selector;
    } catch {}
  }

  // Scroll to trigger any lazy-loaded results
  await page.evaluate(() => window.scrollBy(0, 500)).catch(() => {});
  await sleep(800);

  // One more pass
  for (const selector of RESULT_SELECTORS) {
    try {
      const el = await page.$(selector);
      if (el) return selector;
    } catch {}
  }

  return null;
}

async function extractURLs(page, maxResults) {
  // Try each selector in order
  for (const selector of RESULT_SELECTORS) {
    try {
      const hrefs = await page.$$eval(selector, (els) =>
        els.map((el) => el.href).filter(Boolean)
      );
      const filtered = filterURLs(hrefs);
      if (filtered.length > 0) return filtered.slice(0, maxResults);
    } catch {}
  }

  // Last resort: collect all external <a> links on the page
  try {
    const allHrefs = await page.$$eval('a[href]', (els) =>
      els.map((el) => el.href).filter((h) => h.startsWith('http'))
    );
    return filterURLs(allHrefs).slice(0, maxResults);
  } catch {
    return [];
  }
}

// ─── Main search function ─────────────────────────────────────────────────────

/**
 * @param {string} query
 * @param {{
 *   maxResults?: number,
 *   onProgress?: Function,
 *   retryCount?: number
 * }} options
 * @returns {Promise<{ urls: string[], blocked: boolean, source: string }>}
 */
export async function searchWithPuppeteer(query, {
  maxResults = 15,
  onProgress,
  retryCount = 0,
} = {}) {
  let page;
  try {
    page = await browserManager.getPage();

    const searchUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}&kl=nl-nl&ia=web`;

    await page.goto(searchUrl, {
      waitUntil: 'networkidle2',
      timeout: 25_000,
    });

    // Block detection
    const blocked = await detectBlock(page);
    if (blocked) {
      browserManager.recordBlock();
      const delay = 8_000 + retryCount * 12_000;

      if (retryCount < 2) {
        console.warn(`[Puppeteer] Blocked on "${query}", retry ${retryCount + 1} after ${delay}ms`);
        browserManager.releasePage(page);
        page = null;
        await sleep(delay);
        return searchWithPuppeteer(query, { maxResults, onProgress, retryCount: retryCount + 1 });
      }

      onProgress?.({ query, resultsFound: 0, blocked: true, source: 'puppeteer' });
      return { urls: [], blocked: true, source: 'puppeteer' };
    }

    // Wait for content to render
    await waitForResults(page);

    const urls = await extractURLs(page, maxResults);

    browserManager.recordSuccess();
    onProgress?.({ query, resultsFound: urls.length, blocked: false, source: 'puppeteer' });

    // Adaptive delay before next search
    await sleep(browserManager.currentDelay + Math.random() * 500);

    return { urls, blocked: false, source: 'puppeteer' };
  } catch (err) {
    onProgress?.({ query, resultsFound: 0, blocked: false, error: err.message, source: 'puppeteer' });
    return { urls: [], blocked: false, source: 'puppeteer', error: err.message };
  } finally {
    if (page) browserManager.releasePage(page);
  }
}

export default { searchWithPuppeteer, browserManager };
