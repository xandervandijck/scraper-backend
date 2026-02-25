/**
 * Email Validator — three-tier validation:
 *  1. Regex syntax check
 *  2. DNS MX record lookup
 *  3. Optional SMTP handshake (connect + EHLO + MAIL FROM + RCPT TO)
 */

import dns from 'dns/promises';
import net from 'net';

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'tempmail.com', 'throwaway.email',
  'yopmail.com', 'sharklasers.com', 'guerrillamailblock.com', 'grr.la',
  'guerrillamail.info', 'spam4.me', 'trashmail.com', 'fakeinbox.com',
  'maildrop.cc', 'dispostable.com', '10minutemail.com', 'mailnesia.com',
  'mailnull.com', 'spamgourmet.com', 'spamgourmet.net', 'discard.email',
  'harakirimail.com', 'spambog.com', 'spamfree24.org', 'tempr.email',
]);

// Service/infra domains that appear in HTML but are never real contact emails
const SERVICE_DOMAIN_PATTERNS = [
  /sentry\.io$/, /ingest\.\w+/, /bugsnag\.com$/, /datadog\.com$/,
  /cloudflare\.com$/, /amazonaws\.com$/, /googleapis\.com$/,
  /jsdelivr\.net$/, /unpkg\.com$/, /cdnjs\.cloudflare\.com$/,
  /gravatar\.com$/, /wp\.com$/, /schema\.org$/,
];

const EMAIL_REGEX =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;

/**
 * @param {string} email
 * @param {{ deepValidation?: boolean, timeoutMs?: number }} opts
 * @returns {Promise<{ valid: boolean, score: number, reason: string }>}
 */
export async function validateEmail(email, { deepValidation = false, timeoutMs = 5000 } = {}) {
  // 1. Regex
  if (!EMAIL_REGEX.test(email)) {
    return { valid: false, score: 0, reason: 'invalid_format' };
  }

  const domain = email.split('@')[1].toLowerCase();

  // 2. Disposable check
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return { valid: false, score: 0, reason: 'disposable_domain' };
  }

  // 3a. Service/infra domain check
  if (SERVICE_DOMAIN_PATTERNS.some((p) => p.test(domain))) {
    return { valid: false, score: 0, reason: 'service_domain' };
  }

  // 3. Generic/role addresses get lower score but still valid
  const localPart = email.split('@')[0].toLowerCase();
  const isGeneric = /^(info|contact|admin|support|hello|sales|noreply|no-reply|mail|office|service|help|billing|accounts?)$/.test(localPart);

  // 4. DNS MX lookup
  let mxRecords = [];
  try {
    mxRecords = await withTimeout(dns.resolveMx(domain), timeoutMs);
    if (!mxRecords || mxRecords.length === 0) {
      return { valid: false, score: 10, reason: 'no_mx_records' };
    }
  } catch {
    // DNS failure — could be network issue, treat as uncertain
    return { valid: false, score: 20, reason: 'dns_lookup_failed' };
  }

  const baseScore = isGeneric ? 70 : 85;

  // 5. Optional SMTP handshake
  if (!deepValidation) {
    return { valid: true, score: baseScore, reason: isGeneric ? 'generic_address' : 'mx_verified' };
  }

  const smtpResult = await smtpHandshake(email, mxRecords, timeoutMs);
  if (smtpResult === 'exists') {
    return { valid: true, score: isGeneric ? 75 : 95, reason: isGeneric ? 'generic_smtp_ok' : 'smtp_verified' };
  }
  if (smtpResult === 'rejected') {
    return { valid: false, score: 15, reason: 'smtp_rejected' };
  }
  // Greylisted or inconclusive
  return { valid: true, score: baseScore, reason: 'smtp_inconclusive' };
}

async function smtpHandshake(email, mxRecords, timeoutMs) {
  const sorted = [...mxRecords].sort((a, b) => a.priority - b.priority);
  const mxHost = sorted[0].exchange;

  return new Promise((resolve) => {
    const socket = net.createConnection({ host: mxHost, port: 25 });
    let stage = 0;
    let resolved = false;
    const lines = [];

    const done = (result) => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        resolve(result);
      }
    };

    const timer = setTimeout(() => done('timeout'), timeoutMs);

    socket.on('connect', () => {});
    socket.on('data', (chunk) => {
      const text = chunk.toString();
      lines.push(text);

      if (stage === 0 && text.startsWith('220')) {
        stage = 1;
        socket.write(`EHLO validator.local\r\n`);
      } else if (stage === 1 && (text.startsWith('250') || text.includes('250 '))) {
        stage = 2;
        socket.write(`MAIL FROM:<check@validator.local>\r\n`);
      } else if (stage === 2 && text.startsWith('250')) {
        stage = 3;
        socket.write(`RCPT TO:<${email}>\r\n`);
      } else if (stage === 3) {
        clearTimeout(timer);
        if (text.startsWith('250') || text.startsWith('251')) {
          done('exists');
        } else if (text.startsWith('550') || text.startsWith('551') || text.startsWith('553')) {
          done('rejected');
        } else {
          done('inconclusive');
        }
      }
    });

    socket.on('error', () => { clearTimeout(timer); done('error'); });
    socket.on('timeout', () => { clearTimeout(timer); done('timeout'); });
  });
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

export default { validateEmail };
