import axios from 'axios';
import type { EnrichedProspect, GeneratedAd } from '../types';
import { EMAIL_TEMPLATES } from '../icp-config';
import { rateLimiters, withRetry } from '../utils/rate-limiter';
import { stepLogger } from '../utils/logger';

const log = stepLogger('email-sender');
const INSTANTLY_API = 'https://api.instantly.ai/api/v1';

interface InstantlyLead {
  email: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  personalization?: string;
  website?: string;
  custom_variables?: Record<string, string>;
}

interface InstantlyAddLeadPayload {
  api_key: string;
  campaign_id: string;
  skip_if_in_workspace: boolean;
  leads: InstantlyLead[];
}

export async function sendEmail(prospect: EnrichedProspect): Promise<boolean> {
  const apiKey = process.env.INSTANTLY_API_KEY;
  const campaignId = process.env.INSTANTLY_CAMPAIGN_ID;

  if (!apiKey || !campaignId) {
    log.warn('INSTANTLY_API_KEY or INSTANTLY_CAMPAIGN_ID not set — skipping send');
    return false;
  }

  if (!prospect.email && !prospect.emailWaterfall?.email) {
    log.warn(`No email found for ${prospect.company} — skipping`);
    return false;
  }

  const email = prospect.email ?? prospect.emailWaterfall!.email!;
  const emailContent = buildEmailContent(prospect);
  const sampleAdNote = buildSampleAdNote(prospect.generatedAds ?? []);

  await rateLimiters.instantly.acquire();

  const payload: InstantlyAddLeadPayload = {
    api_key: apiKey,
    campaign_id: campaignId,
    skip_if_in_workspace: true,
    leads: [
      {
        email,
        first_name: prospect.firstName,
        last_name: prospect.lastName,
        company_name: prospect.company,
        website: `https://${prospect.domain}`,
        custom_variables: {
          personalization: emailContent.openingLine,
          ad_insight: emailContent.adInsight,
          recommended_angle: prospect.adStrategy?.recommendedAngle ?? '',
          sample_ad_note: sampleAdNote,
          icp_tier: prospect.icpScore?.tier ?? 'mid',
          icp_score: String(prospect.icpScore?.total ?? 0),
          company: prospect.company,
          domain: prospect.domain,
          industry: prospect.websiteData?.industry ?? '',
          is_running_ads: String(prospect.metaAds?.isRunningAds ?? false),
          ad_count: String(prospect.metaAds?.adCount ?? 0),
          estimated_spend: prospect.metaAds?.estimatedMonthlySpend ?? '',
        },
      },
    ],
  };

  try {
    await withRetry(() =>
      axios.post(`${INSTANTLY_API}/lead/add`, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      })
    );

    log.info(`Added ${prospect.company} (${email}) to Instantly campaign`);
    return true;
  } catch (err: unknown) {
    const msg = (err as { response?: { data?: unknown } })?.response?.data;
    log.error(`Failed to add ${prospect.company} to Instantly`, { error: String(err), response: msg });
    return false;
  }
}

function buildEmailContent(prospect: EnrichedProspect): { openingLine: string; adInsight: string } {
  const hook = prospect.adStrategy?.personalizationHook ?? '';
  const running = prospect.metaAds?.isRunningAds ?? false;

  const adInsight = running
    ? `You're running ${prospect.metaAds!.adCount} Meta ads — ${prospect.adStrategy?.recommendedAngle ?? 'there may be room to improve performance'}.`
    : `${prospect.company} isn't running Meta ads yet — ${prospect.adStrategy?.opportunities?.[0] ?? 'huge opportunity to scale with paid social'}.`;

  return {
    openingLine: hook,
    adInsight,
  };
}

function buildSampleAdNote(ads: GeneratedAd[]): string {
  if (ads.length === 0) return '';
  const concepts = ads.map(a => `"${a.concept.headline}"`).join(', ');
  return `I put together a few sample ad concepts for ${prospects_company(ads)}: ${concepts}. Happy to share the visuals.`;
}

function prospects_company(_ads: GeneratedAd[]): string {
  return 'your brand';
}

export async function sendBatch(
  prospects: EnrichedProspect[],
  onSent?: (prospect: EnrichedProspect) => void,
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;

  for (const prospect of prospects) {
    if (prospect.emailStatus === 'skipped') continue;

    const success = await sendEmail(prospect);
    if (success) {
      sent++;
      prospect.emailSent = true;
      prospect.emailStatus = 'sent';
      onSent?.(prospect);
    } else {
      failed++;
      prospect.emailStatus = 'failed';
    }
  }

  return { sent, failed };
}
