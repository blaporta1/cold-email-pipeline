import { createLogger, format, transports } from 'winston';
import * as path from 'path';
import * as fs from 'fs';

const logsDir = process.env.VERCEL
  ? '/tmp/logs'
  : path.join(process.cwd(), 'logs');

let canWriteLogs = false;
try {
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  canWriteLogs = true;
} catch {
  // Read-only filesystem (Vercel Lambda) — console only
}

const { combine, timestamp, colorize, printf, errors } = format;

const consoleFormat = printf(({ level, message, timestamp: ts, step, company, ...meta }) => {
  const prefix = step ? `[${step}]` : '';
  const ctx = company ? ` ${company}` : '';
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${ts} ${level} ${prefix}${ctx} ${message}${metaStr}`;
});

const loggerTransports: transports.StreamTransportInstance[] = [
  new transports.Console({
    format: combine(colorize(), consoleFormat),
  }),
];

if (canWriteLogs) {
  loggerTransports.push(
    new transports.File({
      filename: path.join(logsDir, 'pipeline.log'),
      format: combine(format.json()),
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
    }) as unknown as transports.StreamTransportInstance,
    new transports.File({
      filename: path.join(logsDir, 'errors.log'),
      level: 'error',
      format: combine(format.json()),
    }) as unknown as transports.StreamTransportInstance,
  );
}

export const logger = createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'HH:mm:ss' }),
  ),
  transports: loggerTransports,
});

export function stepLogger(step: string) {
  return {
    info: (msg: string, meta?: object) => logger.info(msg, { step, ...meta }),
    warn: (msg: string, meta?: object) => logger.warn(msg, { step, ...meta }),
    error: (msg: string, meta?: object) => logger.error(msg, { step, ...meta }),
    debug: (msg: string, meta?: object) => logger.debug(msg, { step, ...meta }),
  };
}
