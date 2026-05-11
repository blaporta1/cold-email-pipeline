import axios from 'axios';
import type { Prospect, DomainValidationResult } from '../types.js';
import { rateLimiters, withRetry } from '../utils/rate-limiter.js';
import { stepLogger } from '../utils/logger.js';

const log = stepLogger('domain-validator');
const HUNTER_API = 'https://api.hunter.io/v2';

interface HunterDomainResponse {
  data: {
    domain: string;
    disposable: boolean;
    webmail: boolean;
    accept_all: boolean;
    pattern: string;
    organization: string;
    emails: unknown[];
    mx_records: boolean;
    smtp_server: boolean;
    smtp_check: boolean;
  };
}

export async function validateDomain(prospect: Prospect): Promise<DomainValidationResult> {
  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey) {
    log.warn('HUNTER_API_KEY not set — skipping domain validation', { domain: prospect.domain });
    return fallbackResult(prospect.domain);
  }

  await rateLimiters.hunter.acquire();

  try {
    const response = await withRetry(() =>
      axios.get<HunterDomainResponse>(`${HUNTER_API}/domain-search`, {
        params: {
          domain: prospect.domain,
          api_key: apiKey,
          limit: 1,
        },
        timeout: 8000,
      })
    );

    const d = response.data.data;
    return {
      valid: d.mx_records && !d.disposable,
      disposable: d.disposable,
      webmail: d.webmail,
      mxRecords: d.mx_records,
      smtpServer: d.smtp_server,
      emailCount: Array.isArray(d.emails) ? d.emails.length : 0,
      organization: d.organization ?? prospect.company,
    };
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 404) {
      return { valid: false, disposable: false, webmail: false, mxRecords: false, smtpServer: false, emailCount: 0, organization: '' };
    }
    log.error(`Domain validation failed for ${prospect.domain}`, { error: String(err) });
    return fallbackResult(prospect.domain);
  }
}

function fallbackResult(domain: string): DomainValidationResult {
  const knownWebmail = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com'];
  return {
    valid: true,
    disposable: false,
    webmail: knownWebmail.includes(domain),
    mxRecords: true,
    smtpServer: true,
    emailCount: 0,
    organization: '',
  };
}

export function isDomainUsable(result: DomainValidationResult): boolean {
  return result.valid && !result.disposable && !result.webmail;
}
