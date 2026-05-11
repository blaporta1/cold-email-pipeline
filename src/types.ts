export interface RawProspect {
  [key: string]: string | undefined;
}

export interface Prospect {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  company: string;
  domain: string;
  title: string;
  linkedinUrl: string;
  email?: string;
}

export interface DomainValidationResult {
  valid: boolean;
  disposable: boolean;
  webmail: boolean;
  mxRecords: boolean;
  smtpServer: boolean;
  emailCount: number;
  organization: string;
}

export interface WebsiteData {
  title: string;
  description: string;
  products: string[];
  positioning: string;
  valueProposition: string;
  industry: string;
  techStack: string[];
  hasEcommerce: boolean;
  hasPricing: boolean;
  rawText: string;
}

export interface MetaAd {
  id: string;
  body: string;
  title: string;
  caption: string;
  snapshotUrl: string;
  startDate: string;
  impressions?: { lower_bound: string; upper_bound: string };
  spend?: { lower_bound: string; upper_bound: string };
}

export interface MetaAdsResult {
  isRunningAds: boolean;
  adCount: number;
  ads: MetaAd[];
  estimatedMonthlySpend: string;
  primaryAdType: 'image' | 'video' | 'carousel' | 'mixed' | 'unknown';
}

export interface AdStrategyAnalysis {
  summary: string;
  targetAudience: string;
  messagingThemes: string[];
  contentTypes: string[];
  estimatedBudget: string;
  strengths: string[];
  weaknesses: string[];
  opportunities: string[];
  recommendedAngle: string;
  personalizationHook: string;
}

export interface ICPScore {
  total: number;
  breakdown: {
    adActivity: number;
    adSpendLevel: number;
    industryFit: number;
    hasEcommerce: number;
    websiteQuality: number;
  };
  tier: 'top' | 'mid' | 'low';
  reasoning: string;
}

export interface GeneratedAdConcept {
  id: string;
  headline: string;
  bodyText: string;
  ctaText: string;
  visualDescription: string;
  targetEmotion: string;
  hook: string;
}

export interface GeneratedAd {
  concept: GeneratedAdConcept;
  imageBase64?: string;
  imageUrl?: string;
  generatedAt: string;
}

export type WaterfallSource =
  | 'apollo_enrich'
  | 'kitt_finder'
  | 'leadmagic_finder'
  | 'hunter_finder'
  | 'leadmagic_personal'
  | 'leadmagic_b2b_social'
  | 'hunter_domain'
  | 'icypeas_finder'
  | 'pattern_guess';

export interface EmailWaterfallResult {
  email?: string;
  source?: WaterfallSource;
  confidence: number;
  pass: 1 | 2;
  verified: boolean;
}

export interface EnrichedProspect extends Prospect {
  domainValidation?: DomainValidationResult;
  websiteData?: WebsiteData;
  metaAds?: MetaAdsResult;
  adStrategy?: AdStrategyAnalysis;
  icpScore?: ICPScore;
  emailWaterfall?: EmailWaterfallResult;
  generatedAds?: GeneratedAd[];
  emailSent: boolean;
  emailStatus: 'pending' | 'sent' | 'failed' | 'skipped';
  processedAt: string;
  errors: string[];
  costUsd: number;
}

export type PipelineStep =
  | 'domain-validation'
  | 'website-scraping'
  | 'meta-ads'
  | 'ai-analysis'
  | 'icp-scoring'
  | 'email-enrichment'
  | 'ad-generation'
  | 'email-delivery';

export interface PipelineConfig {
  concurrency: number;
  batchSize: number;
  skipSteps: PipelineStep[];
  icpTopPercentile: number;
  checkpointDir: string;
  outputDir: string;
}

export interface PipelineProgress {
  sessionId: string;
  step: PipelineStep;
  stepIndex: number;
  totalSteps: number;
  total: number;
  completed: number;
  failed: number;
  percentage: number;
  currentProspect?: string;
  elapsedMs: number;
  estimatedRemainingMs?: number;
}

export interface PipelineResult {
  sessionId: string;
  total: number;
  processed: number;
  topTier: number;
  midTier: number;
  lowTier: number;
  emailsSent: number;
  failed: number;
  totalCostUsd: number;
  costPerProspect: number;
  durationMs: number;
  outputPath: string;
}
