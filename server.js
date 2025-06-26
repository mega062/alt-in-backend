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
function extractVideoId(url) {
  const m = url.match(/(?:v=|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}
function genFilename() {
  return `beat_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.webm`;
}

async function ensureDownloads() {
  try { await fsPromises.access(DOWNLOADS_DIR); }
  catch { await fsPromises.mkdir(DOWNLOADS_DIR, { recursive: true }); }
}

async function recordWithStream(youtubeUrl, info) {
  const browser = await launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();

  try {
    info.status = 'loading';
    info.message = 'Carregando YouTube…';
    await page.goto(youtubeUrl, { waitUntil: 'networkidle2', timeout: 90000 });
    await page.waitForTimeout(5000);

    const title = await page.title();
    info.videoTitle = title.replace(' - YouTube', '').trim();
    info.status = 'recording';
    info.message = 'Gravando áudio…';

    const stream = await getStream(page, { audio: true, video: false });
    const filename = genFilename();
    const filepath = path.join(DOWNLOADS_DIR, filename);
    const file = fs.createWriteStream(filepath);

    stream.pipe(file);
    await new Promise(res => stream.on('end', res));
    file.close();

    const sizeKb = (await fsPromises.stat(filepath)).size / 1024;
    info.status = 'completed';
    info.message = 'Gravação concluída';
    info.outputFile = filepath;
    info.fileSize = Math.round(sizeKb);

    return filepath;

  } catch (err) {
    info.status = 'error';
    info.message = 'Erro: ' + err.message;
    throw err;
  } finally {
    await browser.close();
  }
}

app.post('/record-beat', async (req, res) => {
  const { youtubeUrl } = req.body;
  if (!validateYouTubeUrl(youtubeUrl))
    return res.status(400).json({ error: 'URL inválida' });
  if (activeRecordings.size >= MAX_CONCURRENT)
    return res.status(503).json({ error: 'Servidor ocupado' });

  const id = `rec_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const info = { id, youtubeUrl, status:'queued', message:'Aguardando', progress:0 };
  activeRecordings.set(id, info);

  recordWithStream(youtubeUrl, info)
    .catch(console.error);

  res.json({ success:true, recordingId:id, statusUrl:`/status/${id}` });
});

app.get('/status/:id', (req, res) => {
  const info = activeRecordings.get(req.params.id);
  if (!info) return res.status(404).json({ error:'Gravação não encontrada' });
  res.json(info);
});

app.get('/download/:id', async (req, res) => {
  const info = activeRecordings.get(req.params.id);
  if (!info || info.status !== 'completed')
    return res.status(404).json({ error:'Arquivo não disponível' });

  const fname = path.basename(info.outputFile);
  res.download(info.outputFile, fname, err => {
    if (!err) {
      setTimeout(async () => {
        await fsPromises.unlink(info.outputFile);
        activeRecordings.delete(req.params.id);
      }, 5 * 60 * 1000);
    }
  });
});

async function cleanup() {
  const now = Date.now();
  for (const [id, info] of activeRecordings) {
    if (now - new Date(info.startedAt || now) > 30 * 60 * 1000) {
      if (info.outputFile) await fsPromises.unlink(info.outputFile).catch(() => {});
      activeRecordings.delete(id);
    }
  }
}

app.listen(PORT, async () => {
  await ensureDownloads();
  setInterval(cleanup, CLEANUP_INTERVAL);
  console.log(`Servidor rodando na porta ${PORT}`);
});
