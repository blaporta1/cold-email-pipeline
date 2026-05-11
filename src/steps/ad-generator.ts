import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuid } from 'uuid';
import type { Prospect, WebsiteData, MetaAdsResult, AdStrategyAnalysis, GeneratedAdConcept, GeneratedAd } from '../types';
import { rateLimiters, withRetry } from '../utils/rate-limiter';
import { stepLogger } from '../utils/logger';

const log = stepLogger('ad-generator');

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

export async function generateAdConcepts(
  prospect: Prospect,
  websiteData: WebsiteData,
  analysis: AdStrategyAnalysis,
  count = 3,
): Promise<GeneratedAdConcept[]> {
  if (!process.env.ANTHROPIC_API_KEY) {
    log.warn('ANTHROPIC_API_KEY not set — skipping concept generation');
    return [];
  }

  await rateLimiters.anthropic.acquire();

  const prompt = `Generate ${count} distinct Meta ad concepts for ${prospect.company}.

BUSINESS CONTEXT:
- Description: ${websiteData.description}
- Value prop: ${websiteData.valueProposition}
- Products: ${websiteData.products.slice(0, 5).join(', ')}
- Their current ad weaknesses: ${analysis.weaknesses.join(', ')}
- Opportunities: ${analysis.opportunities.join(', ')}
- Recommended angle: ${analysis.recommendedAngle}

Generate ${count} different ad concepts. Respond ONLY with a JSON array:
[
  {
    "headline": "short punchy headline (< 40 chars)",
    "bodyText": "ad body copy (2-3 sentences, persuasive)",
    "ctaText": "CTA button text",
    "visualDescription": "detailed description for AI image generation (describe scene, colors, style, mood)",
    "targetEmotion": "primary emotion this ad triggers",
    "hook": "the hook — what stops the scroll"
  }
]`;

  try {
    const response = await withRetry(() =>
      getAnthropic().messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }],
        system: 'You are an expert Meta ads copywriter. Respond with valid JSON only.',
      })
    );

    const text = response.content[0].type === 'text' ? response.content[0].text : '[]';
    const concepts = JSON.parse(text) as Omit<GeneratedAdConcept, 'id'>[];
    return concepts.map(c => ({ ...c, id: uuid() }));
  } catch (err) {
    log.error(`Concept generation failed for ${prospect.company}`, { error: String(err) });
    return [];
  }
}

export async function generateAdImage(
  concept: GeneratedAdConcept,
  prospect: Prospect,
  outputDir: string,
): Promise<GeneratedAd> {
  const ad: GeneratedAd = {
    concept,
    generatedAt: new Date().toISOString(),
  };

  if (!process.env.GOOGLE_AI_KEY) {
    log.warn('GOOGLE_AI_KEY not set — skipping image generation');
    return ad;
  }

  await rateLimiters.google.acquire();

  const imagePrompt = buildImagePrompt(concept, prospect);

  try {
    const model = getGenAI().getGenerativeModel({ model: 'gemini-2.0-flash-preview-image-generation' });

    const result = await withRetry(() =>
      model.generateContent({
        contents: [{ role: 'user', parts: [{ text: imagePrompt }] }],
        generationConfig: {
          responseModalities: ['IMAGE', 'TEXT'],
        } as Parameters<typeof model.generateContent>[0] extends { generationConfig?: infer C } ? C : never,
      })
    );

    const candidates = result.response.candidates ?? [];
    for (const candidate of candidates) {
      for (const part of candidate.content?.parts ?? []) {
        if (part.inlineData?.mimeType?.startsWith('image/')) {
          const base64 = part.inlineData.data;
          ad.imageBase64 = base64;

          const imgDir = path.join(outputDir, 'ads', prospect.id);
          if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
          const imgPath = path.join(imgDir, `${concept.id}.png`);
          fs.writeFileSync(imgPath, Buffer.from(base64, 'base64'));
          ad.imageUrl = imgPath;
          log.info(`Generated ad image for ${prospect.company}`, { concept: concept.headline });
        }
      }
    }
  } catch (err) {
    log.error(`Image generation failed for ${prospect.company}`, { error: String(err) });
  }

  return ad;
}

export async function generateAdsForProspect(
  prospect: Prospect,
  websiteData: WebsiteData,
  analysis: AdStrategyAnalysis,
  outputDir: string,
): Promise<GeneratedAd[]> {
  const concepts = await generateAdConcepts(prospect, websiteData, analysis, 3);
  if (concepts.length === 0) return [];

  const ads: GeneratedAd[] = [];
  for (const concept of concepts) {
    const ad = await generateAdImage(concept, prospect, outputDir);
    ads.push(ad);
  }

  log.info(`Generated ${ads.length} ads for ${prospect.company}`);
  return ads;
}

function buildImagePrompt(concept: GeneratedAdConcept, prospect: Prospect): string {
  return `Create a professional Meta/Facebook ad image for ${prospect.company}.

Visual concept: ${concept.visualDescription}
Headline to feature: "${concept.headline}"
Target emotion: ${concept.targetEmotion}
Hook: ${concept.hook}

Style requirements:
- Aspect ratio: 1:1 (square, 1080x1080)
- Professional, high-quality advertising photography or illustration
- Brand-appropriate colors
- Clean, uncluttered composition
- Space for text overlay (don't include actual text in image)
- Eye-catching, scroll-stopping visual
- No watermarks or stock photo aesthetics`;
}
