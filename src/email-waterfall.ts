/**
 * 8-layer, two-pass email enrichment waterfall.
 *
 * Pass 1 — professional/business email discovery:
 *   Layer 1: apollo_enrich
 *   Layer 2: kitt_finder
 *   Layer 3: leadmagic_finder
 *   Layer 4: hunter_finder
 *
 * Pass 2 — personal/social/fallback:
 *   Layer 5: leadmagic_personal
 *   Layer 6: leadmagic_b2b_social
 *   Layer 7: hunter_domain
 *   Layer 8: icypeas_finder
 *   Layer 9: pattern_guess (algorithmic — no API cost)
 */

import axios from 'axios';
import type { Prospect, EmailWaterfallResult, WaterfallSource } from './types.js';
import { rateLimiters, withRetry } from './utils/rate-limiter.js';
import { stepLogger } from './utils/logger.js';

const log = stepLogger('email-waterfall');

// ── Types ────────────────────────────────────────────────────────────────────

interface LayerResult {
  email?: string;
  confidence: number;
  verified: boolean;
}

type Layer = {
  name: WaterfallSource;
  pass: 1 | 2;
  run: (prospect: Prospect) => Promise<LayerResult>;
};

// ── Layer Implementations ────────────────────────────────────────────────────

async function apolloEnrich(prospect: Prospect): Promise<LayerResult> {
  const key = process.env.APOLLO_API_KEY;
  if (!key) return empty();

  await rateLimiters.apollo.acquire();

  try {
    const response = await withRetry(() =>
      axios.post(
        'https://api.apollo.io/v1/people/match',
        {
          first_name: prospect.firstName,
          last_name: prospect.lastName,
          organization_name: prospect.company,
          domain: prospect.domain,
          linkedin_url: prospect.linkedinUrl || undefined,
          reveal_personal_emails: false,
          reveal_phone_number: false,
        },
        {
          headers: { 'Content-Type': 'application/json', 'X-Api-Key': key },
          timeout: 10000,
        }
      )
    );

    const person = response.data?.person;
    const email = person?.email;
    if (!email || email.includes('email_not_unlocked')) return empty();

    return { email, confidence: 90, verified: false };
  } catch {
    return empty();
  }
}

async function kittFinder(prospect: Prospect): Promise<LayerResult> {
  const key = process.env.KITT_API_KEY;
  if (!key) return empty();

  await rateLimiters.kitt.acquire();

  try {
    const response = await withRetry(() =>
      axios.get('https://api.kitt.ai/v1/email/find', {
        params: {
          first_name: prospect.firstName,
          last_name: prospect.lastName,
          domain: prospect.domain,
          company: prospect.company,
        },
        headers: { Authorization: `Bearer ${key}` },
        timeout: 8000,
      })
    );

    const email = response.data?.email;
    if (!email) return empty();
    return { email, confidence: 85, verified: response.data?.verified ?? false };
  } catch {
    return empty();
  }
}

async function leadmagicFinder(prospect: Prospect): Promise<LayerResult> {
  const key = process.env.LEADMAGIC_API_KEY;
  if (!key) return empty();

  await rateLimiters.leadmagic.acquire();

  try {
    const response = await withRetry(() =>
      axios.post(
        'https://api.leadmagic.io/email-finder',
        {
          first_name: prospect.firstName,
          last_name: prospect.lastName,
          domain: prospect.domain,
        },
        {
          headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
          timeout: 8000,
        }
      )
    );

    const email = response.data?.email;
    if (!email) return empty();
    return { email, confidence: 85, verified: response.data?.email_status === 'valid' };
  } catch {
    return empty();
  }
}

async function hunterFinder(prospect: Prospect): Promise<LayerResult> {
  const key = process.env.HUNTER_API_KEY;
  if (!key) return empty();

  await rateLimiters.hunter.acquire();

  try {
    const response = await withRetry(() =>
      axios.get('https://api.hunter.io/v2/email-finder', {
        params: {
          domain: prospect.domain,
          first_name: prospect.firstName,
          last_name: prospect.lastName,
          api_key: key,
        },
        timeout: 8000,
      })
    );

    const data = response.data?.data;
    if (!data?.email) return empty();
    const confidence = data.score ?? 50;
    return { email: data.email, confidence, verified: confidence >= 80 };
  } catch {
    return empty();
  }
}

async function leadmagicPersonal(prospect: Prospect): Promise<LayerResult> {
  const key = process.env.LEADMAGIC_API_KEY;
  if (!key) return empty();

  await rateLimiters.leadmagic.acquire();

  try {
    const response = await withRetry(() =>
      axios.post(
        'https://api.leadmagic.io/personal-email-finder',
        {
          first_name: prospect.firstName,
          last_name: prospect.lastName,
          domain: prospect.domain,
          linkedin_url: prospect.linkedinUrl || undefined,
        },
        {
          headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
          timeout: 8000,
        }
      )
    );

    const email = response.data?.email;
    if (!email) return empty();
    return { email, confidence: 70, verified: false };
  } catch {
    return empty();
  }
}

async function leadmagicB2BSocial(prospect: Prospect): Promise<LayerResult> {
  const key = process.env.LEADMAGIC_API_KEY;
  if (!key || !prospect.linkedinUrl) return empty();

  await rateLimiters.leadmagic.acquire();

  try {
    const response = await withRetry(() =>
      axios.post(
        'https://api.leadmagic.io/profile-finder',
        { linkedin_url: prospect.linkedinUrl },
        {
          headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
          timeout: 8000,
        }
      )
    );

    const email = response.data?.work_email ?? response.data?.email;
    if (!email) return empty();
    return { email, confidence: 75, verified: false };
  } catch {
    return empty();
  }
}

async function hunterDomain(prospect: Prospect): Promise<LayerResult> {
  const key = process.env.HUNTER_API_KEY;
  if (!key) return empty();

  await rateLimiters.hunter.acquire();

  try {
    const response = await withRetry(() =>
      axios.get('https://api.hunter.io/v2/domain-search', {
        params: { domain: prospect.domain, api_key: key, limit: 5 },
        timeout: 8000,
      })
    );

    const emails: Array<{ value: string; confidence: number; first_name?: string; last_name?: string }> =
      response.data?.data?.emails ?? [];

    if (emails.length === 0) return empty();

    const nameMatch = emails.find(
      e =>
        e.first_name?.toLowerCase() === prospect.firstName.toLowerCase() ||
        e.last_name?.toLowerCase() === prospect.lastName.toLowerCase()
    );

    const best = nameMatch ?? emails.sort((a, b) => b.confidence - a.confidence)[0];
    return { email: best.value, confidence: best.confidence, verified: best.confidence >= 80 };
  } catch {
    return empty();
  }
}

async function icypeasFinder(prospect: Prospect): Promise<LayerResult> {
  const apiKey = process.env.ICYPEAS_API_KEY;
  const apiSecret = process.env.ICYPEAS_API_SECRET;
  if (!apiKey || !apiSecret) return empty();

  await rateLimiters.icypeas.acquire();

  try {
    const response = await withRetry(() =>
      axios.post(
        'https://app.icypeas.com/api/email-search',
        {
          firstname: prospect.firstName,
          lastname: prospect.lastName,
          domainOrCompany: prospect.domain,
        },
        {
          headers: {
            Authorization: `${apiKey}:${apiSecret}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      )
    );

    const email = response.data?.item?.emails?.[0]?.email
      ?? response.data?.item?.email;

    if (!email) return empty();
    return { email, confidence: 75, verified: false };
  } catch {
    return empty();
  }
}

function patternGuess(prospect: Prospect): LayerResult {
  if (!prospect.firstName || !prospect.lastName || !prospect.domain) return empty();

  const f = prospect.firstName.toLowerCase().replace(/[^a-z]/g, '');
  const l = prospect.lastName.toLowerCase().replace(/[^a-z]/g, '');
  const d = prospect.domain;

  const patterns = [
    `${f}.${l}@${d}`,
    `${f}@${d}`,
    `${f}${l}@${d}`,
    `${f[0]}${l}@${d}`,
    `${f[0]}.${l}@${d}`,
    `${l}@${d}`,
  ];

  return { email: patterns[0], confidence: 40, verified: false };
}

// ── Waterfall Layers (ordered) ────────────────────────────────────────────────

const LAYERS: Layer[] = [
  { name: 'apollo_enrich',      pass: 1, run: apolloEnrich },
  { name: 'kitt_finder',        pass: 1, run: kittFinder },
  { name: 'leadmagic_finder',   pass: 1, run: leadmagicFinder },
  { name: 'hunter_finder',      pass: 1, run: hunterFinder },
  { name: 'leadmagic_personal', pass: 2, run: leadmagicPersonal },
  { name: 'leadmagic_b2b_social', pass: 2, run: leadmagicB2BSocial },
  { name: 'hunter_domain',      pass: 2, run: hunterDomain },
  { name: 'icypeas_finder',     pass: 2, run: icypeasFinder },
];

// ── Main Waterfall ────────────────────────────────────────────────────────────

export async function runWaterfall(prospect: Prospect): Promise<EmailWaterfallResult> {
  if (prospect.email) {
    log.debug(`${prospect.company}: using pre-existing email`);
    return { email: prospect.email, source: 'apollo_enrich', confidence: 100, pass: 1, verified: true };
  }

  for (const layer of LAYERS) {
    const result = await layer.run(prospect);
    if (result.email) {
      log.info(`${prospect.company}: found email via ${layer.name} (pass ${layer.pass}, conf ${result.confidence})`);
      return {
        email: result.email,
        source: layer.name,
        confidence: result.confidence,
        pass: layer.pass,
        verified: result.verified,
      };
    }
  }

  // Final fallback: algorithmic pattern guess
  const guess = patternGuess(prospect);
  if (guess.email) {
    log.info(`${prospect.company}: falling back to pattern_guess`);
    return { email: guess.email, source: 'pattern_guess', confidence: 40, pass: 2, verified: false };
  }

  log.warn(`${prospect.company}: no email found across all layers`);
  return { confidence: 0, pass: 2, verified: false };
}

function empty(): LayerResult {
  return { confidence: 0, verified: false };
}
