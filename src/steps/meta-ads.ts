import axios from 'axios';
import type { Prospect, WebsiteData, MetaAd, MetaAdsResult } from '../types';
import { rateLimiters, withRetry } from '../utils/rate-limiter';
import { stepLogger } from '../utils/logger';

const log = stepLogger('meta-ads');
const GRAPH_API = 'https://graph.facebook.com/v19.0';

interface GraphAd {
  id: string;
  ad_creative_bodies?: string[];
  ad_creative_link_titles?: string[];
  ad_creative_link_captions?: string[];
  ad_delivery_start_time?: string;
  ad_snapshot_url?: string;
  spend?: { lower_bound: string; upper_bound: string };
  impressions?: { lower_bound: string; upper_bound: string };
}

interface GraphAdsResponse {
  data: GraphAd[];
  paging?: { cursors: { after: string } };
}

export async function checkMetaAds(
  prospect: Prospect,
  websiteData?: WebsiteData,
): Promise<MetaAdsResult> {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) {
    log.warn('META_ACCESS_TOKEN not set — skipping Meta Ads check');
    return emptyResult();
  }

  await rateLimiters.meta.acquire();

  const searchTerms = buildSearchTerms(prospect, websiteData);

  try {
    const ads = await fetchAds(token, searchTerms);

    if (ads.length === 0) {
      return emptyResult();
    }

    const normalized = ads.map(normalizeAd).filter(a => a.body || a.title);
    const spendRange = estimateSpend(normalized);
    const primaryType = detectPrimaryType(normalized);

    return {
      isRunningAds: true,
      adCount: normalized.length,
      ads: normalized,
      estimatedMonthlySpend: spendRange,
      primaryAdType: primaryType,
    };
  } catch (err: unknown) {
    log.error(`Meta Ads check failed for ${prospect.company}`, { error: String(err) });
    return emptyResult();
  }
}

async function fetchAds(token: string, searchTerms: string[]): Promise<GraphAd[]> {
  const allAds: GraphAd[] = [];

  for (const term of searchTerms) {
    try {
      const response = await withRetry(() =>
        axios.get<GraphAdsResponse>(`${GRAPH_API}/ads_archive`, {
          params: {
            access_token: token,
            search_terms: term,
            ad_reached_countries: '["US"]',
            ad_type: 'ALL',
            ad_active_status: 'ALL',
            fields: [
              'id',
              'ad_creative_bodies',
              'ad_creative_link_titles',
              'ad_creative_link_captions',
              'ad_delivery_start_time',
              'ad_snapshot_url',
              'spend',
              'impressions',
            ].join(','),
            limit: 10,
          },
          timeout: 10000,
        })
      );

      allAds.push(...response.data.data);
      if (allAds.length >= 20) break;
    } catch {
      continue;
    }
  }

  return dedupeAds(allAds);
}

function buildSearchTerms(prospect: Prospect, websiteData?: WebsiteData): string[] {
  const terms = [prospect.company];
  const domain = prospect.domain.replace(/\.(com|co|io|net|org)$/, '');
  if (domain !== prospect.company.toLowerCase()) terms.push(domain);
  if (websiteData?.title && websiteData.title !== prospect.company) {
    terms.push(websiteData.title.split('|')[0].trim());
  }
  return [...new Set(terms)].slice(0, 3);
}

function normalizeAd(ad: GraphAd): MetaAd {
  return {
    id: ad.id,
    body: (ad.ad_creative_bodies?.[0] ?? '').slice(0, 500),
    title: (ad.ad_creative_link_titles?.[0] ?? '').slice(0, 200),
    caption: (ad.ad_creative_link_captions?.[0] ?? '').slice(0, 200),
    snapshotUrl: ad.ad_snapshot_url ?? '',
    startDate: ad.ad_delivery_start_time ?? '',
    impressions: ad.impressions,
    spend: ad.spend,
  };
}

function dedupeAds(ads: GraphAd[]): GraphAd[] {
  const seen = new Set<string>();
  return ads.filter(ad => {
    if (seen.has(ad.id)) return false;
    seen.add(ad.id);
    return true;
  });
}

function estimateSpend(ads: MetaAd[]): string {
  const maxLower = Math.max(
    ...ads.map(a => parseInt(a.spend?.lower_bound ?? '0', 10))
  );
  if (maxLower === 0) return 'unknown';
  if (maxLower < 100) return '<$100';
  if (maxLower < 1000) return '$100–$1k';
  if (maxLower < 10000) return '$1k–$10k';
  if (maxLower < 100000) return '$10k–$100k';
  return '$100k+';
}

function detectPrimaryType(ads: MetaAd[]): MetaAdsResult['primaryAdType'] {
  if (ads.length === 0) return 'unknown';
  return 'image';
}

function emptyResult(): MetaAdsResult {
  return {
    isRunningAds: false,
    adCount: 0,
    ads: [],
    estimatedMonthlySpend: 'none',
    primaryAdType: 'unknown',
  };
}
