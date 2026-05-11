import * as fs from 'fs';
import * as path from 'path';
import pLimit from 'p-limit';
import { stringify } from 'csv-stringify/sync';
import type {
  Prospect,
  EnrichedProspect,
  PipelineConfig,
  PipelineProgress,
  PipelineResult,
  PipelineStep,
  ICPScore,
} from './types';
import { validateDomain, isDomainUsable } from './steps/domain-validator';
import { scrapeWebsite } from './steps/website-scraper';
import { checkMetaAds } from './steps/meta-ads';
import { analyzeAdStrategy, generateEmailPersonalization } from './steps/ai-analyzer';
import { scoreProspect, assignTiers } from './steps/icp-scorer';
import { runWaterfall } from './email-waterfall';
import { generateAdsForProspect } from './steps/ad-generator';
import { sendBatch } from './steps/email-sender';
import { logger, stepLogger } from './utils/logger';

const log = stepLogger('pipeline');

export const DEFAULT_CONFIG: PipelineConfig = {
  concurrency: parseInt(process.env.PIPELINE_CONCURRENCY ?? '10', 10),
  batchSize: 100,
  skipSteps: [],
  icpTopPercentile: parseInt(process.env.ICP_TOP_PERCENTILE ?? '20', 10),
  checkpointDir: path.join(process.cwd(), 'checkpoints'),
  outputDir: path.join(process.cwd(), 'output'),
};

// ── Cost constants (USD per call, approximate) ────────────────────────────────
const COST = {
  domainValidation:  0.005,
  websiteScraping:   0.000,
  metaAds:           0.000,
  aiAnalysis:        0.010,
  icpScoring:        0.000,
  emailEnrichment:   0.030,
  adGeneration:      0.050,
  emailDelivery:     0.010,
};

// ── Pipeline Runner ───────────────────────────────────────────────────────────

export async function runPipeline(
  prospects: Prospect[],
  config: Partial<PipelineConfig> = {},
  onProgress?: (progress: PipelineProgress) => void,
): Promise<PipelineResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const sessionId = Date.now().toString();
  const startTime = Date.now();

  log.info(`Starting pipeline: ${prospects.length} prospects, concurrency=${cfg.concurrency}`);

  if (!fs.existsSync(cfg.checkpointDir)) fs.mkdirSync(cfg.checkpointDir, { recursive: true });
  if (!fs.existsSync(cfg.outputDir)) fs.mkdirSync(cfg.outputDir, { recursive: true });

  const checkpointPath = path.join(cfg.checkpointDir, `${sessionId}.json`);
  const enriched: EnrichedProspect[] = prospects.map(p => ({
    ...p,
    emailSent: false,
    emailStatus: 'pending' as const,
    processedAt: '',
    errors: [],
    costUsd: 0,
  }));

  const STEPS: Array<{ name: PipelineStep; label: string; run: (batch: EnrichedProspect[]) => Promise<void> }> = [
    {
      name: 'domain-validation',
      label: 'Domain Validation',
      run: async (batch) => {
        const limit = pLimit(cfg.concurrency);
        await Promise.all(batch.map(p => limit(async () => {
          try {
            p.domainValidation = await validateDomain(p);
            if (!isDomainUsable(p.domainValidation)) {
              p.emailStatus = 'skipped';
            }
            p.costUsd += COST.domainValidation;
          } catch (err) {
            p.errors.push(`domain-validation: ${String(err)}`);
          }
        })));
      },
    },
    {
      name: 'website-scraping',
      label: 'Website Scraping',
      run: async (batch) => {
        const limit = pLimit(cfg.concurrency);
        const active = batch.filter(p => p.emailStatus !== 'skipped');
        await Promise.all(active.map(p => limit(async () => {
          try {
            p.websiteData = await scrapeWebsite(p);
          } catch (err) {
            p.errors.push(`website-scraping: ${String(err)}`);
          }
        })));
      },
    },
    {
      name: 'meta-ads',
      label: 'Meta Ads Check',
      run: async (batch) => {
        const limit = pLimit(Math.min(cfg.concurrency, 5));
        const active = batch.filter(p => p.emailStatus !== 'skipped');
        await Promise.all(active.map(p => limit(async () => {
          try {
            p.metaAds = await checkMetaAds(p, p.websiteData);
          } catch (err) {
            p.errors.push(`meta-ads: ${String(err)}`);
          }
        })));
      },
    },
    {
      name: 'ai-analysis',
      label: 'AI Strategy Analysis',
      run: async (batch) => {
        const limit = pLimit(Math.min(cfg.concurrency, 5));
        const active = batch.filter(p => p.emailStatus !== 'skipped');
        await Promise.all(active.map(p => limit(async () => {
          try {
            if (p.websiteData || p.metaAds) {
              p.adStrategy = await analyzeAdStrategy(
                p.company,
                p.websiteData ?? emptyWebsite(),
                p.metaAds ?? emptyMetaAds(),
              );
              const hook = await generateEmailPersonalization(p.company, p.adStrategy, p.metaAds ?? emptyMetaAds());
              p.adStrategy.personalizationHook = hook;
              p.costUsd += COST.aiAnalysis;
            }
          } catch (err) {
            p.errors.push(`ai-analysis: ${String(err)}`);
          }
        })));
      },
    },
    {
      name: 'icp-scoring',
      label: 'ICP Scoring',
      run: async (batch) => {
        const active = batch.filter(p => p.emailStatus !== 'skipped');
        const rawScores = active.map(p => scoreProspect(p, p.websiteData, p.metaAds, p.adStrategy));
        const tiered = assignTiers(rawScores, cfg.icpTopPercentile);
        active.forEach((p, i) => { p.icpScore = tiered[i]; });
      },
    },
    {
      name: 'email-enrichment',
      label: 'Email Enrichment',
      run: async (batch) => {
        const limit = pLimit(cfg.concurrency);
        const active = batch.filter(p => p.emailStatus !== 'skipped');
        await Promise.all(active.map(p => limit(async () => {
          try {
            p.emailWaterfall = await runWaterfall(p);
            if (p.emailWaterfall.email) {
              p.email = p.emailWaterfall.email;
            }
            p.costUsd += COST.emailEnrichment;
          } catch (err) {
            p.errors.push(`email-enrichment: ${String(err)}`);
          }
        })));
      },
    },
    {
      name: 'ad-generation',
      label: 'AI Ad Generation (Top 20%)',
      run: async (batch) => {
        const topTier = batch.filter(p => p.icpScore?.tier === 'top' && p.emailStatus !== 'skipped');
        const limit = pLimit(2);
        await Promise.all(topTier.map(p => limit(async () => {
          try {
            if (p.websiteData && p.adStrategy) {
              p.generatedAds = await generateAdsForProspect(p, p.websiteData, p.adStrategy, cfg.outputDir);
              p.costUsd += COST.adGeneration;
            }
          } catch (err) {
            p.errors.push(`ad-generation: ${String(err)}`);
          }
        })));
      },
    },
    {
      name: 'email-delivery',
      label: 'Email Delivery (Instantly)',
      run: async (batch) => {
        const sendable = batch.filter(p => p.email && p.emailStatus !== 'skipped');
        await sendBatch(sendable, (p) => {
          p.costUsd += COST.emailDelivery;
          p.processedAt = new Date().toISOString();
        });
      },
    },
  ];

  const stepsToRun = STEPS.filter(s => !cfg.skipSteps.includes(s.name));

  for (let i = 0; i < stepsToRun.length; i++) {
    const step = stepsToRun[i];
    if (cfg.skipSteps.includes(step.name)) continue;

    log.info(`Step ${i + 1}/${stepsToRun.length}: ${step.label}`);
    const stepStart = Date.now();

    try {
      await step.run(enriched);
    } catch (err) {
      log.error(`Step ${step.name} failed`, { error: String(err) });
    }

    const stepDuration = Date.now() - stepStart;
    log.info(`${step.label} completed in ${(stepDuration / 1000).toFixed(1)}s`);

    onProgress?.({
      sessionId,
      step: step.name,
      stepIndex: i + 1,
      totalSteps: stepsToRun.length,
      total: enriched.length,
      completed: enriched.filter(p => p.processedAt || p.emailStatus !== 'pending').length,
      failed: enriched.filter(p => p.errors.length > 0).length,
      percentage: Math.round(((i + 1) / stepsToRun.length) * 100),
      elapsedMs: Date.now() - startTime,
    });

    fs.writeFileSync(checkpointPath, JSON.stringify(enriched.slice(0, 100), null, 2));
  }

  const result = buildResult(sessionId, enriched, startTime, cfg.outputDir);
  saveOutputs(enriched, result, cfg.outputDir);

  log.info(`Pipeline complete: ${result.emailsSent} emails sent, $${result.totalCostUsd.toFixed(2)} total ($${result.costPerProspect.toFixed(2)}/prospect)`);
  return result;
}

function buildResult(
  sessionId: string,
  enriched: EnrichedProspect[],
  startTime: number,
  outputDir: string,
): PipelineResult {
  const total = enriched.length;
  const processed = enriched.filter(p => p.processedAt).length;
  const topTier = enriched.filter(p => p.icpScore?.tier === 'top').length;
  const midTier = enriched.filter(p => p.icpScore?.tier === 'mid').length;
  const lowTier = enriched.filter(p => p.icpScore?.tier === 'low').length;
  const emailsSent = enriched.filter(p => p.emailSent).length;
  const failed = enriched.filter(p => p.errors.length > 0).length;
  const totalCostUsd = enriched.reduce((sum, p) => sum + p.costUsd, 0);

  return {
    sessionId,
    total,
    processed,
    topTier,
    midTier,
    lowTier,
    emailsSent,
    failed,
    totalCostUsd,
    costPerProspect: total > 0 ? totalCostUsd / total : 0,
    durationMs: Date.now() - startTime,
    outputPath: outputDir,
  };
}

function saveOutputs(enriched: EnrichedProspect[], result: PipelineResult, outputDir: string) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const jsonPath = path.join(outputDir, `results-${ts}.json`);
  const csvPath  = path.join(outputDir, `results-${ts}.csv`);

  fs.writeFileSync(jsonPath, JSON.stringify({ result, prospects: enriched }, null, 2));

  const csvRows = enriched.map(p => ({
    id: p.id,
    firstName: p.firstName,
    lastName: p.lastName,
    company: p.company,
    domain: p.domain,
    email: p.email ?? '',
    emailSource: p.emailWaterfall?.source ?? '',
    icpScore: p.icpScore?.total ?? '',
    icpTier: p.icpScore?.tier ?? '',
    isRunningAds: p.metaAds?.isRunningAds ?? '',
    adCount: p.metaAds?.adCount ?? '',
    estimatedSpend: p.metaAds?.estimatedMonthlySpend ?? '',
    industry: p.websiteData?.industry ?? '',
    emailStatus: p.emailStatus,
    adsGenerated: (p.generatedAds?.length ?? 0) > 0,
    personalizationHook: p.adStrategy?.personalizationHook ?? '',
    costUsd: p.costUsd.toFixed(3),
    errors: p.errors.join('; '),
  }));

  fs.writeFileSync(csvPath, stringify(csvRows, { header: true }));
  log.info(`Saved results to ${csvPath}`);
}

function emptyWebsite() {
  return {
    title: '', description: '', products: [], positioning: '',
    valueProposition: '', industry: 'unknown', techStack: [],
    hasEcommerce: false, hasPricing: false, rawText: '',
  };
}

function emptyMetaAds() {
  return {
    isRunningAds: false, adCount: 0, ads: [],
    estimatedMonthlySpend: 'none', primaryAdType: 'unknown' as const,
  };
}
