import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import type { WebsiteData, MetaAdsResult, AdStrategyAnalysis } from '../types';
import { rateLimiters, withRetry } from '../utils/rate-limiter';
import { stepLogger } from '../utils/logger';

const log = stepLogger('ai-analyzer');

let _anthropic: Anthropic | null = null;
let _genAI: GoogleGenerativeAI | null = null;

function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

function getGenAI() {
  if (!_genAI) _genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_KEY!);
  return _genAI;
}

export async function analyzeAdStrategy(
  company: string,
  websiteData: WebsiteData,
  metaAds: MetaAdsResult,
): Promise<AdStrategyAnalysis> {
  if (!process.env.ANTHROPIC_API_KEY) {
    log.warn('ANTHROPIC_API_KEY not set — skipping AI analysis');
    return fallbackAnalysis(company, websiteData, metaAds);
  }

  await rateLimiters.anthropic.acquire();

  const adsContext = metaAds.isRunningAds
    ? `They are running ${metaAds.adCount} Meta ads. Sample ads:\n${metaAds.ads.slice(0, 3).map(a => `- "${a.title}": ${a.body}`).join('\n')}\nEstimated monthly spend: ${metaAds.estimatedMonthlySpend}`
    : 'They are NOT currently running Meta ads.';

  const prompt = `Analyze this business and their ad strategy for a cold outreach personalization engine.

COMPANY: ${company}
WEBSITE TITLE: ${websiteData.title}
DESCRIPTION: ${websiteData.description}
VALUE PROP: ${websiteData.valueProposition}
INDUSTRY: ${websiteData.industry}
HAS ECOMMERCE: ${websiteData.hasEcommerce}
TECH STACK: ${websiteData.techStack.join(', ')}

META ADS STATUS: ${adsContext}

Respond ONLY with valid JSON matching this exact schema:
{
  "summary": "2-3 sentence summary of their business and ad approach",
  "targetAudience": "who they're targeting",
  "messagingThemes": ["theme1", "theme2", "theme3"],
  "contentTypes": ["image", "carousel", etc],
  "estimatedBudget": "estimated monthly ad spend range",
  "strengths": ["strength1", "strength2"],
  "weaknesses": ["weakness1", "weakness2"],
  "opportunities": ["opportunity1", "opportunity2"],
  "recommendedAngle": "the specific angle to use when reaching out to this company",
  "personalizationHook": "a specific 1-sentence observation about their ads/business to open a cold email with"
}`;

  try {
    const response = await withRetry(() =>
      getAnthropic().messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
        system: 'You are an expert performance marketing analyst. Always respond with valid JSON only, no markdown.',
      })
    );

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    return JSON.parse(text) as AdStrategyAnalysis;
  } catch (err) {
    log.error(`AI analysis failed for ${company}`, { error: String(err) });
    return fallbackAnalysis(company, websiteData, metaAds);
  }
}

export async function generateEmailPersonalization(
  company: string,
  analysis: AdStrategyAnalysis,
  metaAds: MetaAdsResult,
): Promise<string> {
  if (!process.env.GOOGLE_AI_KEY) return analysis.personalizationHook;

  await rateLimiters.google.acquire();

  const model = getGenAI().getGenerativeModel({ model: 'gemini-2.0-flash' });

  const prompt = `Write a single personalized opening sentence for a cold email to ${company}.

Context:
- Business summary: ${analysis.summary}
- They're running ${metaAds.adCount} Meta ads
- Their main messaging themes: ${analysis.messagingThemes.join(', ')}
- Recommended angle: ${analysis.recommendedAngle}
- Existing hook: ${analysis.personalizationHook}

Rules:
- 1 sentence max
- Specific to what they're actually doing, not generic
- Don't start with "I noticed" or "I saw"
- Conversational, not salesy
- Reference something specific (an ad, their positioning, their product)`;

  try {
    const result = await withRetry(() => model.generateContent(prompt));
    return result.response.text().trim().replace(/^["']|["']$/g, '');
  } catch {
    return analysis.personalizationHook;
  }
}

function fallbackAnalysis(company: string, websiteData: WebsiteData, metaAds: MetaAdsResult): AdStrategyAnalysis {
  const hook = metaAds.isRunningAds
    ? `${company} is running ${metaAds.adCount} active Meta ads with ${metaAds.estimatedMonthlySpend} estimated monthly spend`
    : `${company} isn't running Meta ads yet — there's a clear opportunity here`;

  return {
    summary: `${company} operates in the ${websiteData.industry} space. ${websiteData.description.slice(0, 150)}`,
    targetAudience: 'consumers / businesses in their market',
    messagingThemes: websiteData.products.slice(0, 3),
    contentTypes: [metaAds.primaryAdType],
    estimatedBudget: metaAds.estimatedMonthlySpend,
    strengths: websiteData.hasEcommerce ? ['active ecommerce presence'] : [],
    weaknesses: metaAds.isRunningAds ? [] : ['no paid social presence'],
    opportunities: ['scale paid social'],
    recommendedAngle: metaAds.isRunningAds ? 'improve existing ad performance' : 'launch paid social',
    personalizationHook: hook,
  };
}
