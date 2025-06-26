// server.js - Versão sem display virtual
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
  // Em produção, usar puppeteer com configuração otimizada para serverless
  const puppeteer = require('puppeteer');
  const { getStream } = require('puppeteer-stream');
  
  launch = async (options = {}) => {
    return await puppeteer.launch({
      headless: 'new',
      executablePath: '/usr/bin/google-chrome',
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
        '--mute-audio',
        '--password-store=basic',
        '--use-mock-keychain',
        '--autoplay-policy=no-user-gesture-required',
        '--virtual-time-budget=5000',
        '--disable-audio-output',
        '--ignore-certificate-errors',
        '--disable-software-rasterizer',
        '--disable-canvas-aa',
        '--disable-2d-canvas-clip-aa',
        '--disable-gl-drawing-for-tests'
      ],
      ignoreDefaultArgs: ['--disable-extensions'],
      ...options
    });
  };
  
  // Usar getStream diretamente
  getStream = getStream;
} else {
  // Em desenvolvimento, usar configuração padrão
  const { launch: puppeteerLaunch, getStream: puppeteerGetStream } = require('puppeteer-stream');
  launch = puppeteerLaunch;
  getStream = puppeteerGetStream;
}

const app = express();
const PORT = process.env.PORT || 10000;
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const MAX_CONCURRENT = 1; // Reduzido para 1 em produção
const CLEANUP_INTERVAL = 3 * 60 * 1000; // 3 minutos
const RECORDING_TIMEOUT = 120000; // 2 minutos timeout
const activeRecordings = new Map();

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// CORS configurado
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  
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
    environment: isProd ? 'production' : 'development',
    memory: process.memoryUsage(),
    uptime: process.uptime()
  });
});

// Endpoint de teste
app.get('/', (req, res) => {
  res.json({
    message: '🎵 Beat Recorder API está funcionando!',
    endpoints: {
      health: '/health',
      record: 'POST /record',
      status: 'GET /status/:id',
      download: 'GET /download/:id'
    }
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
    await page.waitForSelector('h1', { timeout: 10000 });
    
    const title = await page.evaluate(() => {
      const selectors = [
        'h1.ytd-video-primary-info-renderer yt-formatted-string',
        'h1.style-scope.ytd-video-primary-info-renderer',
        'h1 yt-formatted-string',
        'h1[data-title]',
        'h1'
      ];
      
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element && element.textContent) {
          return element.textContent.trim();
        }
      }
      return 'YouTube Video';
    });

    const author = await page.evaluate(() => {
      const selectors = [
        '#owner-name a',
        '.ytd-channel-name a',
        '[data-author]',
        'ytd-video-owner-renderer a'
      ];
      
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element && element.textContent) {
          return element.textContent.trim();
        }
      }
      return 'Unknown';
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
  let progressInterval = null;
  
  try {
    console.log(`🎬 Iniciando gravação: ${info.id}`);
    info.status = 'opening_browser';
    info.message = 'Abrindo navegador...';
    info.progress = 5;
    
    // Timeout de segurança
    timeoutId = setTimeout(() => {
      if (info.status !== 'completed') {
        info.status = 'error';
        info.error = 'Timeout: Gravação excedeu o tempo limite de 2 minutos';
      }
    }, RECORDING_TIMEOUT);

    browser = await launch({
      headless: 'new',
      defaultViewport: { width: 1280, height: 720 }
    });

    info.progress = 10;
    const page = await browser.newPage();
    
    // Configurações da página
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    
    info.status = 'loading_video';
    info.message = 'Carregando vídeo...';
    info.progress = 20;
    
    console.log(`📺 Acessando URL: ${url}`);
    await page.goto(url, { 
      waitUntil: 'domcontentloaded', 
      timeout: 30000 
    });

    info.progress = 30;

    // Aguardar o player carregar
    await page.waitForSelector('video', { timeout: 15000 });
    
    info.progress = 40;

    // Obter informações do vídeo
    const videoInfo = await getVideoInfo(page);
    info.videoTitle = videoInfo.title;
    info.videoAuthor = videoInfo.author;

    info.progress = 50;

    // Tentar reproduzir o vídeo
    try {
      await page.evaluate(() => {
        const video = document.querySelector('video');
        if (video) {
          video.muted = false;
          video.volume = 1.0;
          return video.play();
        }
      });
      
      // Aguardar um pouco para o vídeo começar
      await page.waitForTimeout(3000);
      
    } catch (e) {
      console.log('Tentando métodos alternativos para reproduzir...');
      
      // Método alternativo: clicar no botão play
      try {
        await page.click('.ytp-large-play-button', { timeout: 5000 });
      } catch (e2) {
        console.log('Botão play não encontrado, continuando...');
      }
    }

    info.status = 'preparing_recording';
    info.message = 'Preparando gravação...';
    info.progress = 60;
    
    await page.waitForTimeout(2000);

    info.status = 'recording';
    info.message = 'Gravando beat...';
    info.progress = 70;

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

    info.progress = 80;

    // Atualizar progresso durante a gravação
    progressInterval = setInterval(() => {
      if (info.status === 'recording' && info.progress < 90) {
        info.progress += 2;
      }
    }, 1000);

    // Gravar por 20 segundos
    await new Promise((resolve, reject) => {
      const recordingTimer = setTimeout(() => {
        stream.destroy();
        resolve();
      }, 20000); // 20 segundos de gravação
      
      stream.on('end', () => {
        clearTimeout(recordingTimer);
        resolve();
      });
      
      stream.on('error', (err) => {
        clearTimeout(recordingTimer);
        reject(err);
      });
    });

    if (progressInterval) {
      clearInterval(progressInterval);
      progressInterval = null;
    }

    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }

    info.status = 'processing';
    info.message = 'Processando áudio...';
    info.progress = 95;

    // Aguardar um pouco para garantir que o arquivo foi escrito
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Verificar se o arquivo foi criado
    try {
      const stats = await fsPromises.stat(output);
      info.fileSize = Math.round(stats.size / 1024); // KB
      
      if (stats.size < 1000) { // Arquivo muito pequeno
        throw new Error('Arquivo de áudio muito pequeno - possível falha na gravação');
      }
    } catch (statError) {
      throw new Error('Falha ao verificar arquivo gravado: ' + statError.message);
    }

    info.status = 'completed';
    info.message = 'Gravação concluída!';
    info.progress = 100;
    info.file = output;
    info.downloadUrl = `/download/${info.id}`;

    console.log(`✅ Gravação concluída: ${info.id} (${info.fileSize} KB)`);

  } catch (err) {
    console.error(`❌ Erro na gravação ${info.id}:`, err.message);
    
    if (timeoutId) clearTimeout(timeoutId);
    if (progressInterval) clearInterval(progressInterval);
    
    info.status = 'error';
    info.error = err.message.includes('timeout') || err.message.includes('Timeout') ? 
      'Timeout: O vídeo demorou muito para carregar' : 
      'Erro durante a gravação: ' + err.message;
  } finally {
    if (browser) {
      try {
        await browser.close();
        console.log(`🗂️ Browser fechado para gravação ${info.id}`);
      } catch (e) {
        console.error('Erro ao fechar browser:', e.message);
      }
    }
  }
}

app.post('/record', async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL é obrigatória' });
    }
    
    if (!validateYouTubeUrl(url)) {
      return res.status(400).json({ error: 'URL inválida do YouTube' });
    }
    
    if (activeRecordings.size >= MAX_CONCURRENT) {
      return res.status(429).json({ 
        error: 'Servidor ocupado. Tente novamente em alguns minutos.',
        activeRecordings: activeRecordings.size
      });
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
    
    console.log(`🎵 Nova solicitação de gravação: ${id} - ${url}`);
    
    // Iniciar gravação assíncrona
    setImmediate(async () => {
      try {
        await ensureDownloadsDir();
        await recordWithStream(url, info);
      } catch (err) {
        console.error(`Erro fatal na gravação ${id}:`, err);
        info.status = 'error';
        info.error = 'Erro interno do servidor: ' + err.message;
      }
    });
    
    res.json({ success: true, recordingId: id });
    
  } catch (error) {
    console.error('Erro no endpoint /record:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.get('/status/:id', (req, res) => {
  try {
    const info = activeRecordings.get(req.params.id);
    if (!info) {
      return res.status(404).json({ error: 'Gravação não encontrada' });
    }
    res.json(info);
  } catch (error) {
    console.error('Erro no endpoint /status:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.get('/download/:id', async (req, res) => {
  try {
    const info = activeRecordings.get(req.params.id);
    
    if (!info) {
      return res.status(404).json({ error: 'Gravação não encontrada' });
    }
    
    if (info.status !== 'completed') {
      return res.status(400).json({ 
        error: 'Gravação ainda não foi concluída',
        status: info.status
      });
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
    
  } catch (error) {
    console.error('Erro no endpoint /download:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Limpeza periódica
setInterval(async () => {
  const now = Date.now();
  const toDelete = [];
  
  for (const [id, rec] of activeRecordings.entries()) {
    const recordingTime = parseInt(id.split('_')[1]);
    const age = now - recordingTime;
    
    // Remover gravações antigas (mais de 6 minutos)
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

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Recebido SIGTERM, iniciando shutdown graceful...');
  process.exit(0);
});

// Inicialização do servidor
async function startServer() {
  try {
    await ensureDownloadsDir();
    
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Servidor rodando na porta ${PORT}`);
      console.log(`📁 Diretório de downloads: ${DOWNLOADS_DIR}`);
      console.log(`🎵 Pronto para gravar beats!`);
      console.log(`🌍 Ambiente: ${isProd ? 'Produção' : 'Desenvolvimento'}`);
    });
  } catch (error) {
    console.error('❌ Erro ao iniciar servidor:', error);
    process.exit(1);
  }
}

startServer();