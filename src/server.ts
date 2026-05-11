import express from 'express';
import { createServer } from 'http';
import { Server as SocketIO } from 'socket.io';
import multer from 'multer';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { parseCSVBuffer } from './steps/csv-parser.js';
import { runPipeline, DEFAULT_CONFIG } from './pipeline.js';
import type { PipelineProgress, PipelineResult, PipelineConfig } from './types.js';
import { logger } from './utils/logger.js';

const app  = express();
const http = createServer(app);
const io   = new SocketIO(http, { cors: { origin: '*' } });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, file.mimetype === 'text/csv' || file.originalname.endsWith('.csv'));
  },
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Active sessions ────────────────────────────────────────────────────────────
const sessions = new Map<string, { result?: PipelineResult; status: 'running' | 'done' | 'error' }>();

// ── Routes ────────────────────────────────────────────────────────────────────

app.post('/api/upload', upload.single('csv'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No CSV file uploaded' });
    return;
  }

  try {
    const prospects = parseCSVBuffer(req.file.buffer);
    res.json({
      count: prospects.length,
      sample: prospects.slice(0, 5).map(p => ({ company: p.company, domain: p.domain, firstName: p.firstName })),
      sessionPreview: prospects[0],
    });
  } catch (err) {
    res.status(422).json({ error: `CSV parse error: ${String(err)}` });
  }
});

app.post('/api/pipeline/start', upload.single('csv'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No CSV file uploaded' });
    return;
  }

  const sessionId = `session-${Date.now()}`;
  sessions.set(sessionId, { status: 'running' });

  let prospects;
  try {
    prospects = parseCSVBuffer(req.file.buffer);
  } catch (err) {
    res.status(422).json({ error: `CSV parse error: ${String(err)}` });
    return;
  }

  const config: Partial<PipelineConfig> = {
    concurrency: parseInt(req.body.concurrency ?? '10', 10),
    icpTopPercentile: parseInt(req.body.icpTopPercentile ?? '20', 10),
    skipSteps: req.body.skipSteps ? JSON.parse(req.body.skipSteps) : [],
  };

  res.json({ sessionId, total: prospects.length });

  setImmediate(async () => {
    try {
      const result = await runPipeline(
        prospects,
        config,
        (progress: PipelineProgress) => {
          io.to(sessionId).emit('progress', progress);
        },
      );

      sessions.set(sessionId, { status: 'done', result });
      io.to(sessionId).emit('complete', result);
    } catch (err) {
      logger.error('Pipeline error', { sessionId, error: String(err) });
      sessions.set(sessionId, { status: 'error' });
      io.to(sessionId).emit('error', { message: String(err) });
    }
  });
});

app.get('/api/pipeline/:sessionId/status', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json(session);
});

app.get('/api/pipeline/:sessionId/results', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session?.result) {
    res.status(404).json({ error: 'No results yet' });
    return;
  }
  res.json(session.result);
});

app.get('/api/outputs', (_req, res) => {
  const outputDir = path.join(process.cwd(), 'output');
  if (!fs.existsSync(outputDir)) {
    res.json({ files: [] });
    return;
  }
  const files = fs.readdirSync(outputDir)
    .filter(f => f.endsWith('.csv') || f.endsWith('.json'))
    .map(f => {
      const stat = fs.statSync(path.join(outputDir, f));
      return { name: f, size: stat.size, created: stat.birthtime };
    })
    .sort((a, b) => b.created.getTime() - a.created.getTime());
  res.json({ files });
});

app.get('/api/outputs/:filename', (req, res) => {
  const filePath = path.join(process.cwd(), 'output', path.basename(req.params.filename));
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: 'File not found' });
    return;
  }
  res.download(filePath);
});

// ── Ad Generator API ──────────────────────────────────────────────────────────

app.post('/api/ad-generator/concepts', express.json(), async (req, res) => {
  const { company, domain, websiteData, adStrategy } = req.body;

  if (!company) {
    res.status(400).json({ error: 'company is required' });
    return;
  }

  try {
    const { generateAdConcepts } = await import('./steps/ad-generator.js');
    const prospect = { id: 'preview', firstName: '', lastName: '', fullName: company, company, domain, title: '', linkedinUrl: '' };
    const concepts = await generateAdConcepts(prospect, websiteData ?? emptyWebsite(), adStrategy ?? {}, 3);
    res.json({ concepts });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/ad-generator/image', express.json(), async (req, res) => {
  const { concept, company, domain } = req.body;

  if (!concept) {
    res.status(400).json({ error: 'concept is required' });
    return;
  }

  try {
    const { generateAdImage } = await import('./steps/ad-generator.js');
    const outputDir = path.join(process.cwd(), 'output');
    const prospect = { id: `preview-${Date.now()}`, firstName: '', lastName: '', fullName: company, company, domain, title: '', linkedinUrl: '' };
    const ad = await generateAdImage(concept, prospect, outputDir);
    res.json({ ad: { ...ad, imageBase64: ad.imageBase64 ? ad.imageBase64.slice(0, 50) + '...' : null, hasImage: !!ad.imageBase64 } });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Socket.io ─────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  socket.on('join', (sessionId: string) => {
    socket.join(sessionId);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

if (!process.env.VERCEL) {
  const PORT = parseInt(process.env.PORT ?? '3000', 10);
  http.listen(PORT, () => {
    const localIp = getLocalIP();
    logger.info(`Cold Email Pipeline running at http://localhost:${PORT}`);
    if (localIp) logger.info(`Network: http://${localIp}:${PORT}`);
  });
}

function getLocalIP(): string | null {
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const addr of iface ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}

function emptyWebsite() {
  return {
    title: '', description: '', products: [], positioning: '',
    valueProposition: '', industry: 'unknown', techStack: [],
    hasEcommerce: false, hasPricing: false, rawText: '',
  };
}

export default app;
