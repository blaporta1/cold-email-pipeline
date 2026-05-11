import axios from 'axios';
import * as cheerio from 'cheerio';
import type { Prospect, WebsiteData } from '../types';
import { rateLimiters, withRetry } from '../utils/rate-limiter';
import { ICP_CONFIG } from '../icp-config';
import { stepLogger } from '../utils/logger';

const log = stepLogger('website-scraper');

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export async function scrapeWebsite(prospect: Prospect): Promise<WebsiteData> {
  const url = `https://${prospect.domain}`;

  await rateLimiters.scraper.acquire();

  try {
    const response = await withRetry(() =>
      axios.get(url, {
        timeout: 12000,
        maxRedirects: 5,
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
      })
    );

    return parseHTML(response.data, prospect.domain);
  } catch (err: unknown) {
    log.warn(`Failed to scrape ${url}`, { error: String(err) });
    return emptyWebsiteData();
  }
}

function parseHTML(html: string, domain: string): WebsiteData {
  const $ = cheerio.load(html);

  $('script, style, nav, footer, header').remove();

  const title = $('title').text().trim()
    || $('h1').first().text().trim()
    || domain;

  const description = $('meta[name="description"]').attr('content')?.trim()
    || $('meta[property="og:description"]').attr('content')?.trim()
    || '';

  const bodyText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 3000);

  const products = extractProducts($);
  const industry = detectIndustry(bodyText + ' ' + title + ' ' + description);
  const techStack = detectTechStack($, html);
  const hasEcommerce = detectEcommerce($, bodyText);
  const hasPricing = /pric(e|ing)|plan(s)?|\$\d|\bper month\b|\bper year\b/i.test(bodyText);

  const h1s = $('h1, h2').map((_, el) => $(el).text().trim()).get().filter(t => t.length > 10 && t.length < 120);
  const valueProposition = h1s[0] ?? description.slice(0, 150);
  const positioning = buildPositioning(title, description, h1s);

  return {
    title,
    description,
    products,
    positioning,
    valueProposition,
    industry,
    techStack,
    hasEcommerce,
    hasPricing,
    rawText: bodyText,
  };
}

function extractProducts($: cheerio.CheerioAPI): string[] {
  const products: string[] = [];
  const selectors = [
    '.product-name',
    '.product-title',
    '[class*="product"] h2',
    '[class*="product"] h3',
    '.collection-item h2',
    '.item-title',
  ];

  for (const sel of selectors) {
    $(sel).each((_, el) => {
      const text = $(el).text().trim();
      if (text && text.length < 80) products.push(text);
    });
    if (products.length >= 5) break;
  }

  return [...new Set(products)].slice(0, 10);
}

function detectIndustry(text: string): string {
  const lower = text.toLowerCase();
  for (const industry of ICP_CONFIG.targetIndustries) {
    if (lower.includes(industry)) return industry;
  }
  if (/shop|store|buy|cart|checkout/i.test(text)) return 'e-commerce';
  if (/saas|software|app|platform/i.test(text)) return 'saas';
  if (/agency|marketing|ads|media/i.test(text)) return 'marketing agency';
  return 'unknown';
}

function detectTechStack($: cheerio.CheerioAPI, html: string): string[] {
  const stack: string[] = [];
  if (html.includes('Shopify')) stack.push('Shopify');
  if (html.includes('WooCommerce') || html.includes('woocommerce')) stack.push('WooCommerce');
  if ($('meta[name="generator"]').attr('content')?.includes('WordPress')) stack.push('WordPress');
  if (html.includes('react') || html.includes('_next')) stack.push('React/Next.js');
  if (html.includes('klaviyo')) stack.push('Klaviyo');
  if (html.includes('hotjar')) stack.push('Hotjar');
  if (html.includes('fbq(') || html.includes('facebook-pixel')) stack.push('Meta Pixel');
  if (html.includes('gtag') || html.includes('ga4')) stack.push('Google Analytics');
  return stack;
}

function detectEcommerce($: cheerio.CheerioAPI, text: string): boolean {
  const ecomSignals = ['add to cart', 'add to bag', 'buy now', 'checkout', 'shopping cart', 'view cart'];
  const lower = text.toLowerCase();
  return ecomSignals.some(s => lower.includes(s)) || !!$('[class*="cart"], [id*="cart"]').length;
}

function buildPositioning(title: string, description: string, h1s: string[]): string {
  const parts = [description || title, ...h1s.slice(0, 2)].filter(Boolean);
  return parts.join(' — ').slice(0, 300);
}

function emptyWebsiteData(): WebsiteData {
  return {
    title: '',
    description: '',
    products: [],
    positioning: '',
    valueProposition: '',
    industry: 'unknown',
    techStack: [],
    hasEcommerce: false,
    hasPricing: false,
    rawText: '',
  };
}
