// server.js
const express = require('express');
const { launch, getStream } = require('puppeteer-stream');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const MAX_CONCURRENT = 3;
const CLEANUP_INTERVAL = 10 * 60 * 1000;
const activeRecordings = new Map();

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  req.method === 'OPTIONS' ? res.sendStatus(200) : next();
});

function validateYouTubeUrl(url) {
  return /^(https?:\/\/)?(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)[\w-]{11}/.test(url);
}

function generateFilename() {
  const stamp = Date.now();
  const rand = crypto.randomBytes(4).toString('hex');
  return `beat_${stamp}_${rand}.webm`;
}

async function ensureDownloadsDir() {
  try {
    await fsPromises.access(DOWNLOADS_DIR);
  } catch {
    await fsPromises.mkdir(DOWNLOADS_DIR);
  }
}

async function recordWithStream(url, info) {
  const browser = await launch({ headless: 'new' });
  const page = await browser.newPage();
  const output = path.join(DOWNLOADS_DIR, generateFilename());

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForTimeout(8000);
    info.status = 'recording';

    const stream = await getStream(page, { audio: true, video: false });
    const outStream = fs.createWriteStream(output);
    stream.pipe(outStream);

    await new Promise(resolve => stream.on('end', resolve));
    info.status = 'completed';
    info.file = output;
  } catch (err) {
    info.status = 'error';
    info.error = err.message;
  } finally {
    await browser.close();
  }
}

app.post('/record', async (req, res) => {
  const { url } = req.body;
  if (!validateYouTubeUrl(url)) return res.status(400).json({ error: 'Invalid URL' });
  if (activeRecordings.size >= MAX_CONCURRENT) return res.status(429).json({ error: 'Server busy' });

  const id = `rec_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const info = { id, url, status: 'queued' };
  activeRecordings.set(id, info);

  (async () => {
    await ensureDownloadsDir();
    await recordWithStream(url, info);
  })();

  res.json({ success: true, id });
});

app.get('/status/:id', (req, res) => {
  const info = activeRecordings.get(req.params.id);
  if (!info) return res.status(404).json({ error: 'Not found' });
  res.json(info);
});

app.get('/download/:id', async (req, res) => {
  const info = activeRecordings.get(req.params.id);
  if (!info || info.status !== 'completed') return res.status(404).json({ error: 'Not ready' });

  res.download(info.file, err => {
    if (!err) {
      fsPromises.unlink(info.file).catch(() => {});
      activeRecordings.delete(req.params.id);
    }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [id, rec] of activeRecordings.entries()) {
    if (rec.status === 'completed' && now - parseInt(id.split('_')[1]) > CLEANUP_INTERVAL) {
      fsPromises.unlink(rec.file).catch(() => {});
      activeRecordings.delete(id);
    }
  }
}, CLEANUP_INTERVAL);

ensureDownloadsDir().then(() => {
  app.listen(PORT, () => console.log(`🚀 Rodando na porta ${PORT}`));
});
