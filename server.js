// server.js
const express = require('express');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

// Configuração para ambiente de produção
const isProd = process.env.NODE_ENV === 'production';

let launch, getStream;

// Configuração do Puppeteer baseada no ambiente
if (isProd) {
  // Em produção, usar puppeteer com Chrome instalado
  const puppeteerStream = require('puppeteer-stream');
  const puppeteer = require('puppeteer');
  
  launch = async (options = {}) => {
    return await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-breakpad',
        '--disable-client-side-phishing-detection',
        '--disable-component-extensions-with-background-pages',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-features=TranslateUI',
        '--disable-hang-monitor',
        '--disable-ipc-flooding-protection',
        '--disable-popup-blocking',
        '--disable-prompt-on-repost',
        '--disable-renderer-backgrounding',
        '--disable-sync',
        '--force-color-profile=srgb',
        '--metrics-recording-only',
        '--no-default-browser-check',
        '--no-first-run',
        '--mute-audio',
        '--password-store=basic',
        '--use-mock-keychain',
        '--autoplay-policy=no-user-gesture-required'
      ],
      ...options
    });
  };
  
  getStream = puppeteerStream.getStream;
} else {
  // Em desenvolvimento, usar configuração padrão
  const puppeteerStream = require('puppeteer-stream');
  launch = puppeteerStream.launch;
  getStream = puppeteerStream.getStream;
}

const app = express();
const PORT = process.env.PORT || 10000; // Render usa porta 10000
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const MAX_CONCURRENT = 2; // Reduzido para ambiente de produção
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutos
const RECORDING_TIMEOUT = 300000; // 5 minutos timeout
const activeRecordings = new Map();

app.use(express.json());

// CORS mais específico
app.use((req, res, next) => {
  const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:3001', 
    'https://your-frontend-domain.vercel.app', // Substitua pela sua URL do frontend
    process.env.FRONTEND_URL
  ].filter(Boolean);

  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    activeRecordings: activeRecordings.size,
    environment: isProd ? 'production' : 'development'
  });
});

function validateYouTubeUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|embed\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/.test(url);
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
    await fsPromises.mkdir(DOWNLOADS_DIR, { recursive: true });
  }
}

async function getVideoInfo(page) {
  try {
    const title = await page.evaluate(() => {
      const titleElement = document.querySelector('h1.ytd-video-primary-info-renderer yt-formatted-string') ||
                           document.querySelector('h1.style-scope.ytd-video-primary-info-renderer') ||
                           document.querySelector('[data-title]');
      return titleElement ? titleElement.textContent.trim() : 'YouTube Video';
    });

    const author = await page.evaluate(() => {
      const authorElement = document.querySelector('#owner-name a') ||
                           document.querySelector('.ytd-channel-name a') ||
                           document.querySelector('[data-author]');
      return authorElement ? authorElement.textContent.trim() : 'Unknown';
    });

    return { title, author };
  } catch (error) {
    console.log('Erro ao obter info do vídeo:', error.message);
    return { title: 'YouTube Video', author: 'Unknown' };
  }
}

async function recordWithStream(url, info) {
  let browser = null;
  let timeoutId = null;
  
  try {
    console.log(`🎬 Iniciando gravação: ${info.id}`);
    info.status = 'opening_browser';
    info.message = 'Abrindo navegador...';
    
    // Timeout de segurança
    timeoutId = setTimeout(() => {
      info.status = 'error';
      info.error = 'Timeout: Gravação excedeu o tempo limite';
    }, RECORDING_TIMEOUT);

    browser = await launch({
      headless: 'new',
      defaultViewport: { width: 1920, height: 1080 }
    });

    const page = await browser.newPage();
    
    // Configurações da página
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });

    info.status = 'loading_video';
    info.message = 'Carregando vídeo...';
    
    console.log(`📺 Acessando URL: ${url}`);
    await page.goto(url, { 
      waitUntil: 'networkidle2', 
      timeout: 60000 
    });

    // Obter informações do vídeo
    const videoInfo = await getVideoInfo(page);
    info.videoTitle = videoInfo.title;
    info.videoAuthor = videoInfo.author;

    // Tentar clicar no botão play se necessário
    try {
      await page.click('button[aria-label="Reproduzir"]', { timeout: 5000 });
    } catch (e) {
      console.log('Botão play não encontrado ou vídeo já está tocando');
    }

    info.status = 'preparing_recording';
    info.message = 'Preparando gravação...';
    
    // Aguardar o vídeo carregar
    await page.waitForTimeout(8000);

    info.status = 'recording';
    info.message = 'Gravando beat...';
    info.progress = 10;

    const filename = generateFilename();
    const output = path.join(DOWNLOADS_DIR, filename);
    
    console.log(`🔴 Iniciando gravação de áudio para: ${output}`);
    
    const stream = await getStream(page, { 
      audio: true, 
      video: false,
      mimeType: 'audio/webm;codecs=opus'
    });
    
    const outStream = fs.createWriteStream(output);
    stream.pipe(outStream);

    // Atualizar progresso durante a gravação
    const progressInterval = setInterval(() => {
      if (info.status === 'recording' && info.progress < 90) {
        info.progress += 10;
      }
    }, 5000);

    // Aguardar o final da gravação
    await new Promise((resolve, reject) => {
      stream.on('end', resolve);
      stream.on('error', reject);
      
      // Gravação por tempo determinado (30 segundos)
      setTimeout(() => {
        stream.destroy();
        resolve();
      }, 30000);
    });

    clearInterval(progressInterval);
    clearTimeout(timeoutId);

    info.status = 'processing';
    info.message = 'Processando áudio...';
    info.progress = 95;

    // Verificar se o arquivo foi criado
    const stats = await fsPromises.stat(output);
    info.fileSize = Math.round(stats.size / 1024); // KB

    info.status = 'completed';
    info.message = 'Gravação concluída!';
    info.progress = 100;
    info.file = output;
    info.downloadUrl = `/download/${info.id}`;

    console.log(`✅ Gravação concluída: ${info.id} (${info.fileSize} KB)`);

  } catch (err) {
    console.error(`❌ Erro na gravação ${info.id}:`, err.message);
    
    if (timeoutId) clearTimeout(timeoutId);
    
    info.status = 'error';
    info.error = err.message.includes('timeout') ? 
      'Timeout: O vídeo demorou muito para carregar' : 
      'Erro durante a gravação: ' + err.message;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.error('Erro ao fechar browser:', e.message);
      }
    }
  }
}

app.post('/record', async (req, res) => {
  const { url } = req.body;
  
  if (!validateYouTubeUrl(url)) {
    return res.status(400).json({ error: 'URL inválida do YouTube' });
  }
  
  if (activeRecordings.size >= MAX_CONCURRENT) {
    return res.status(429).json({ error: 'Servidor ocupado. Tente novamente em alguns minutos.' });
  }
  
  const id = `rec_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const info = { 
    id, 
    url, 
    status: 'queued',
    message: 'Na fila para gravação...',
    progress: 0,
    startedAt: new Date().toISOString()
  };
  
  activeRecordings.set(id, info);
  
  console.log(`🎵 Nova solicitação de gravação: ${id}`);
  
  // Iniciar gravação assíncrona
  (async () => {
    await ensureDownloadsDir();
    await recordWithStream(url, info);
  })().catch(err => {
    console.error(`Erro fatal na gravação ${id}:`, err);
    info.status = 'error';
    info.error = 'Erro interno do servidor';
  });
  
  res.json({ success: true, recordingId: id });
});

app.get('/status/:id', (req, res) => {
  const info = activeRecordings.get(req.params.id);
  if (!info) {
    return res.status(404).json({ error: 'Gravação não encontrada' });
  }
  res.json(info);
});

app.get('/download/:id', async (req, res) => {
  const info = activeRecordings.get(req.params.id);
  
  if (!info) {
    return res.status(404).json({ error: 'Gravação não encontrada' });
  }
  
  if (info.status !== 'completed') {
    return res.status(400).json({ error: 'Gravação ainda não foi concluída' });
  }
  
  if (!info.file || !fs.existsSync(info.file)) {
    return res.status(404).json({ error: 'Arquivo não encontrado' });
  }
  
  const filename = `${info.videoTitle?.replace(/[^\w\s-]/g, '').trim() || 'beat'}_complete.webm`;
  
  res.download(info.file, filename, (err) => {
    if (!err) {
      // Limpar arquivo após download
      fsPromises.unlink(info.file).catch(() => {});
      activeRecordings.delete(req.params.id);
      console.log(`📥 Download concluído e arquivo removido: ${req.params.id}`);
    } else {
      console.error(`Erro no download ${req.params.id}:`, err.message);
    }
  });
});

// Limpeza periódica
setInterval(async () => {
  const now = Date.now();
  const toDelete = [];
  
  for (const [id, rec] of activeRecordings.entries()) {
    const recordingTime = parseInt(id.split('_')[1]);
    const age = now - recordingTime;
    
    // Remover gravações antigas (mais de 10 minutos)
    if (age > CLEANUP_INTERVAL * 2) {
      toDelete.push(id);
      
      if (rec.file && fs.existsSync(rec.file)) {
        try {
          await fsPromises.unlink(rec.file);
          console.log(`🗑️ Arquivo antigo removido: ${rec.file}`);
        } catch (e) {
          console.error(`Erro ao remover arquivo: ${e.message}`);
        }
      }
    }
  }
  
  toDelete.forEach(id => activeRecordings.delete(id));
  
  if (toDelete.length > 0) {
    console.log(`🧹 Limpeza: ${toDelete.length} gravações antigas removidas`);
  }
}, CLEANUP_INTERVAL);

// Tratamento de erros globais
process.on('uncaughtException', (err) => {
  console.error('Erro não capturado:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Promise rejeitada:', reason);
});

// Inicialização do servidor
async function startServer() {
  try {
    await ensureDownloadsDir();
    
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Servidor rodando na porta ${PORT}`);
      console.log(`📁 Diretório de downloads: ${DOWNLOADS_DIR}`);
      console.log(`🎵 Pronto para gravar beats!`);
    });
  } catch (error) {
    console.error('❌ Erro ao iniciar servidor:', error);
    process.exit(1);
  }
}

startServer();