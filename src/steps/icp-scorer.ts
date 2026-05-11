import type { Prospect, WebsiteData, MetaAdsResult, AdStrategyAnalysis, ICPScore } from '../types.js';
import { ICP_CONFIG } from '../icp-config.js';
import { stepLogger } from '../utils/logger.js';

const log = stepLogger('icp-scorer');

export function scoreProspect(
  prospect: Prospect,
  websiteData: WebsiteData | undefined,
  metaAds: MetaAdsResult | undefined,
  analysis: AdStrategyAnalysis | undefined,
): ICPScore {
  const weights = ICP_CONFIG.weights;

  // ── Ad Activity (35 pts) ───────────────────────────────────────────────────
  let adActivity = 0;
  if (metaAds?.isRunningAds) {
    adActivity = 60;
    if (metaAds.adCount >= 5) adActivity += 20;
    if (metaAds.adCount >= 10) adActivity += 20;
  }
  adActivity = cap(adActivity);

  // ── Ad Spend Level (25 pts) ────────────────────────────────────────────────
  let adSpendLevel = 0;
  const spend = metaAds?.estimatedMonthlySpend ?? 'none';
  if (spend === '$10k–$100k') adSpendLevel = 100;
  else if (spend === '$1k–$10k') adSpendLevel = 80;
  else if (spend === '$100–$1k') adSpendLevel = 50;
  else if (spend === '$100k+') adSpendLevel = 90;
  else if (spend === 'none' && metaAds?.isRunningAds) adSpendLevel = 40;
  else if (spend === 'none') adSpendLevel = 20;

  // ── Industry Fit (20 pts) ──────────────────────────────────────────────────
  let industryFit = 0;
  const industry = (websiteData?.industry ?? analysis?.targetAudience ?? '').toLowerCase();
  const targetIndustries = ICP_CONFIG.targetIndustries.map(i => i.toLowerCase());
  if (targetIndustries.some(t => industry.includes(t))) industryFit = 100;

  // Check negative keywords
  const negKw = ICP_CONFIG.negativeKeywords;
  const rawText = (websiteData?.rawText ?? '').toLowerCase();
  if (negKw.some(kw => rawText.includes(kw))) industryFit = 0;

  // ── Ecommerce Presence (10 pts) ────────────────────────────────────────────
  const hasEcommerce = websiteData?.hasEcommerce ? 100 : 0;

  // ── Website Quality (10 pts) ───────────────────────────────────────────────
  let websiteQuality = 30;
  if (websiteData?.description) websiteQuality += 20;
  if (websiteData?.products && websiteData.products.length > 0) websiteQuality += 20;
  if (websiteData?.techStack && websiteData.techStack.length > 0) websiteQuality += 20;
  if (websiteData?.hasPricing) websiteQuality += 10;
  websiteQuality = cap(websiteQuality);

  const total = Math.round(
    (adActivity    * weights.adActivity    / 100) +
    (adSpendLevel  * weights.adSpendLevel  / 100) +
    (industryFit   * weights.industryFit   / 100) +
    (hasEcommerce  * weights.hasEcommerce  / 100) +
    (websiteQuality * weights.websiteQuality / 100)
  );

  const reasoning = buildReasoning(prospect.company, adActivity, adSpendLevel, industryFit, hasEcommerce, websiteQuality);

  log.debug(`Scored ${prospect.company}: ${total}/100`, { adActivity, adSpendLevel, industryFit });

  return {
    total,
    breakdown: { adActivity, adSpendLevel, industryFit, hasEcommerce, websiteQuality },
    tier: 'pending' as unknown as 'top',
    reasoning,
  };
}

export function assignTiers(scores: ICPScore[], topPercentile: number): ICPScore[] {
  const sorted = [...scores].sort((a, b) => b.total - a.total);
  const topN = Math.ceil(sorted.length * (topPercentile / 100));
  const topThreshold = sorted[topN - 1]?.total ?? 0;
  const midThreshold = sorted[Math.ceil(sorted.length * 0.6) - 1]?.total ?? 0;

  return scores.map(score => ({
    ...score,
    tier: score.total >= topThreshold ? 'top' : score.total >= midThreshold ? 'mid' : 'low',
  }));
}

function buildReasoning(
  company: string,
  adActivity: number,
  adSpendLevel: number,
  industryFit: number,
  hasEcommerce: number,
  websiteQuality: number,
): string {
  const notes: string[] = [];
  if (adActivity >= 80) notes.push('strong ad activity');
  else if (adActivity === 0) notes.push('not running ads');
  if (adSpendLevel >= 80) notes.push('high estimated spend');
  if (industryFit === 100) notes.push('strong industry fit');
  else if (industryFit === 0) notes.push('poor industry fit');
  if (hasEcommerce === 100) notes.push('has ecommerce');
  if (websiteQuality < 50) notes.push('limited website data');
  return notes.join(', ') || 'scored on available signals';
}

function cap(n: number): number {
  return Math.min(100, Math.max(0, n));
}
