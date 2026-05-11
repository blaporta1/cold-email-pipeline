import { parse } from 'csv-parse/sync';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuid } from 'uuid';
import type { RawProspect, Prospect } from '../types';
import { stepLogger } from '../utils/logger';

const log = stepLogger('csv-parser');

const FIELD_ALIASES: Record<string, string[]> = {
  firstName:   ['first_name', 'firstname', 'first name', 'fname', 'given_name'],
  lastName:    ['last_name', 'lastname', 'last name', 'lname', 'surname', 'family_name'],
  company:     ['company', 'company_name', 'organization', 'org', 'employer', 'business'],
  domain:      ['domain', 'website', 'url', 'web', 'site', 'company_domain'],
  title:       ['title', 'job_title', 'position', 'role', 'designation'],
  linkedinUrl: ['linkedin', 'linkedin_url', 'linkedin_profile', 'profile_url'],
  email:       ['email', 'email_address', 'work_email', 'business_email'],
};

function resolveField(row: RawProspect, fieldName: string): string {
  const aliases = FIELD_ALIASES[fieldName] ?? [fieldName];
  for (const alias of aliases) {
    const found = Object.keys(row).find(k => k.toLowerCase().trim() === alias);
    if (found && row[found]) return (row[found] as string).trim();
  }
  return '';
}

function normalizeDomain(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split('/')[0]
    .toLowerCase()
    .trim();
}

export function parseCSVBuffer(buffer: Buffer): Prospect[] {
  const records: RawProspect[] = parse(buffer, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });

  log.info(`Parsed ${records.length} rows from CSV`);

  const prospects: Prospect[] = [];
  let skipped = 0;

  for (const row of records) {
    const firstName = resolveField(row, 'firstName');
    const lastName  = resolveField(row, 'lastName');
    const company   = resolveField(row, 'company');
    const rawDomain = resolveField(row, 'domain') || resolveField(row, 'email').split('@')[1] || '';
    const domain    = normalizeDomain(rawDomain);

    if (!company || !domain) {
      skipped++;
      continue;
    }

    prospects.push({
      id: uuid(),
      firstName: firstName || 'there',
      lastName,
      fullName: [firstName, lastName].filter(Boolean).join(' ') || company,
      company,
      domain,
      title: resolveField(row, 'title'),
      linkedinUrl: resolveField(row, 'linkedinUrl'),
      email: resolveField(row, 'email') || undefined,
    });
  }

  log.info(`Normalized ${prospects.length} prospects (skipped ${skipped} missing company/domain)`);
  return prospects;
}

export function parseCSVFile(filePath: string): Prospect[] {
  const buffer = fs.readFileSync(filePath);
  return parseCSVBuffer(buffer);
}

export function chunked<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
