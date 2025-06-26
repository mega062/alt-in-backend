// server.js - Gravação REAL otimizada para Render
const express = require('express');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const activeRecordings = new Map();
const MAX_CONCURRENT = 1;
const RECORDING_TIMEOUT = 45000; // 45 segundos máximo

// Configuração do Puppeteer
const isProd = process.env.NODE_ENV === 'production';
let puppeteer, getStream;

try {
  puppeteer = require('puppeteer');
  const puppeteerStream = require('puppeteer-stream');
  getStream = puppeteerStream.getStream;
  console.log('✅ Puppeteer carregado');
} catch (error) {
  console.error('❌ Erro ao carregar Puppeteer:', error.message);
  process.exit(1);
}

app.use(express.json({ limit: '5mb' }));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    activeRecordings: activeRecordings.size,
    timestamp: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  res.json({
    message: '🎵 Beat Recorder API - SUPER RÁPIDO',
    status: 'online',
    activeRecordings: activeRecordings.size
  });
});

function validateYouTubeUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|embed\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/.test(url);
}

function generateFilename() {
  return `beat_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.webm`;
}

async function ensureDownloadsDir() {
  try {
    await fsPromises.access(DOWNLOADS_DIR);
  } catch {
    await fsPromises.mkdir(DOWNLOADS_DIR, { recursive: true });
  }
}

async function fastRecording(url, info) {
  let browser = null;
  let page = null;
  let stream = null;
  
  const timeoutId = setTimeout(() => {
    if (info.status !== 'completed' && info.status !== 'error') {
      info.status = 'error';
      info.error = 'Timeout: Processo demorou mais que 45 segundos';
    }
  }, RECORDING_TIMEOUT);
  
  try {
    console.log(`🚀 Gravação SUPER RÁPIDA: ${info.id}`);
    
    info.status = 'opening_browser';
    info.message = 'Abrindo navegador...';
    info.progress = 10;
    
    // Configuração ULTRA-RÁPIDA
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--no-zygote',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-background-networking',
        '--disable-client-side-phishing-detection',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-sync',
        '--no-default-browser-check',
        '--no-first-run',
        '--autoplay-policy=no-user-gesture-required',
        '--enable-features=WebRTC-HideLocalIpsWithMdns',
        '--disable-audio-output',
        '--mute-audio=false',
        '--allow-running-insecure-content',
        '--disable-component-update',
        '--disable-domain-reliability',
        '--disable-features=TranslateUI',
        '--disable-ipc-flooding-protection',
        '--disable-popup-blocking',
        '--disable-prompt-on-repost',
        '--memory-pressure-off',
        '--max_old_space_size=256' // Limitar RAM
      ],
      executablePath: isProd ? process.env.PUPPETEER_EXECUTABLE_PATH : undefined,
      timeout: 15000 // 15 segundos para abrir
    });
    
    info.progress = 20;
    page = await browser.newPage();
    
    // Configuração super básica
    await page.setViewport({ width: 640, height: 360 }); // Menor resolução = mais rápido
    await page.setUserAgent('Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Mobile');
    
    // Bloquear recursos desnecessários
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const resourceType = request.resourceType();
      const url = request.url();
      
      // Bloquear tudo exceto o essencial
      if (resourceType === 'image' || 
          resourceType === 'stylesheet' || 
          resourceType === 'font' ||
          url.includes('ads') ||
          url.includes('analytics') ||
          url.includes('tracking')) {
        request.abort();
      } else {
        request.continue();
      }
    });
    
    info.status = 'loading_video';
    info.message = 'Carregando vídeo (modo rápido)...';
    info.progress = 30;
    
    console.log(`📺 Acessando: ${url}`);
    
    // Navegação super rápida
    await page.goto(url, { 
      waitUntil: 'domcontentloaded', // Mais rápido que networkidle
      timeout: 10000 // Apenas 10 segundos
    });
    
    info.progress = 40;
    
    // Aguardar vídeo com timeout menor
    try {
      await page.waitForSelector('video', { timeout: 8000 });
    } catch (e) {
      console.log('⚠️ Video não encontrado rapidamente, continuando...');
    }
    
    info.progress = 50;
    
    // Obter título RÁPIDO
    try {
      const title = await page.evaluate(() => {
        const titleEl = document.querySelector('title');
        return titleEl ? titleEl.textContent.replace(' - YouTube', '').trim() : 'YouTube Video';
      });
      info.videoTitle = title;
    } catch (e) {
      info.videoTitle = 'YouTube Video';
    }
    
    info.status = 'preparing_recording';
    info.message = 'Iniciando gravação...';
    info.progress = 60;
    
    // Reproduzir RAPIDAMENTE
    await page.evaluate(() => {
      const video = document.querySelector('video');
      if (video) {
        video.muted = false;
        video.volume = 1.0;
        video.play().catch(() => {});
        
        // Tentar clicar no play também
        const playBtn = document.querySelector('.ytp-large-play-button');
        if (playBtn) playBtn.click();
      }
    });
    
    // Aguardar menos tempo
    await page.waitForTimeout(2000);
    
    info.status = 'recording';
    info.message = 'Gravando...';
    info.progress = 70;
    
    const filename = generateFilename();
    const output = path.join(DOWNLOADS_DIR, filename);
    
    console.log(`🔴 Capturando áudio: ${output}`);
    
    // Stream com configuração leve
    stream = await getStream(page, { 
      audio: true, 
      video: false,
      mimeType: 'audio/webm;codecs=opus',
      audioBitsPerSecond: 64000 // Reduzido para 64kbps = mais rápido
    });
    
    const writeStream = fs.createWriteStream(output);
    stream.pipe(writeStream);
    
    info.progress = 80;
    
    // Gravar apenas 10 segundos (mais rápido)
    await new Promise((resolve, reject) => {
      const recordingDuration = 10000; // 10 segundos
      
      const timer = setTimeout(() => {
        console.log(`⏹️ Parando gravação: ${info.id}`);
        if (stream && !stream.destroyed) {
          stream.destroy();
        }
        resolve();
      }, recordingDuration);
      
      stream.on('end', () => {
        clearTimeout(timer);
        resolve();
      });
      
      stream.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      
      // Progresso mais rápido
      const progressTimer = setInterval(() => {
        if (info.progress < 90) {
          info.progress += 3;
        }
      }, 500);
      
      stream.on('end', () => clearInterval(progressTimer));
      stream.on('error', () => clearInterval(progressTimer));
    });
    
    clearTimeout(timeoutId);
    
    info.status = 'processing';
    info.message = 'Finalizando...';
    info.progress = 95;
    
    // Aguardar menos
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Verificar arquivo
    try {
      const stats = await fsPromises.stat(output);
      info.fileSize = Math.round(stats.size / 1024);
      
      console.log(`✅ Arquivo: ${info.fileSize} KB`);
      
      if (stats.size < 500) {
        console.log('⚠️ Arquivo pequeno, mas continuando...');
      }
    } catch (statError) {
      throw new Error('Erro no arquivo: ' + statError.message);
    }
    
    info.status = 'completed';
    info.message = 'Gravação rápida concluída!';
    info.progress = 100;
    info.file = output;
    info.downloadUrl = `/download/${info.id}`;
    
    console.log(`🎉 SUCESSO RÁPIDO: ${info.id} (${info.fileSize} KB)`);
    
  } catch (err) {
    console.error(`❌ Erro rápido ${info.id}:`, err.message);
    
    clearTimeout(timeoutId);
    
    let errorMessage = err.message;
    if (err.message.includes('timeout') || err.message.includes('Timeout')) {
      errorMessage = 'Vídeo demorou muito - tente um vídeo mais popular/rápido';
    } else if (err.message.includes('Navigation')) {
      errorMessage = 'Erro ao acessar YouTube - URL pode estar incorreta';
    } else if (err.message.includes('Session')) {
      errorMessage = 'Sessão perdida - servidor reiniciando, tente novamente';
    }
    
    info.status = 'error';
    info.error = errorMessage;
    
  } finally {
    // Cleanup super rápido
    try {
      if (stream && !stream.destroyed) stream.destroy();
      if (page && !page.isClosed()) await page.close();
      if (browser && browser.isConnected()) await browser.close();
    } catch (e) {
      console.log('Cleanup:', e.message);
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
      return res.status(400).json({ error: 'URL do YouTube inválida' });
    }
    
    if (activeRecordings.size >= MAX_CONCURRENT) {
      return res.status(429).json({ 
        error: 'Servidor ocupado. Tente novamente em 1 minuto.',
        activeRecordings: activeRecordings.size
      });
    }
    
    const id = `rec_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const info = {
      id,
      url,
      status: 'queued',
      message: 'Na fila rápida...',
      progress: 0,
      startedAt: new Date().toISOString()
    };
    
    activeRecordings.set(id, info);
    console.log(`🚀 GRAVAÇÃO RÁPIDA: ${id}`);
    
    // Iniciar imediatamente
    setImmediate(async () => {
      try {
        await ensureDownloadsDir();
        await fastRecording(url, info);
      } catch (error) {
        console.error(`Erro fatal ${id}:`, error);
        info.status = 'error';
        info.error = 'Erro interno: ' + error.message;
      }
    });
    
    res.json({ success: true, recordingId: id });
    
  } catch (error) {
    console.error('Erro no /record:', error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.get('/status/:id', (req, res) => {
  const info = activeRecordings.get(req.params.id);
  if (!info) {
    return res.status(404).json({ error: 'Gravação não encontrada' });
  }
  res.json(info);
});

app.get('/download/:id', async (req, res) => {
  try {
    const info = activeRecordings.get(req.params.id);
    
    if (!info) {
      return res.status(404).json({ error: 'Gravação não encontrada' });
    }
    
    if (info.status !== 'completed') {
      return res.status(400).json({ 
        error: 'Gravação não concluída',
        status: info.status
      });
    }
    
    if (!info.file || !fs.existsSync(info.file)) {
      return res.status(404).json({ error: 'Arquivo não encontrado' });
    }
    
    const filename = `${info.videoTitle?.replace(/[^\w\s-]/g, '').trim() || 'beat'}_fast.webm`;
    
    res.download(info.file, filename, (err) => {
      if (!err) {
        fsPromises.unlink(info.file).catch(() => {});
        activeRecordings.delete(req.params.id);
        console.log(`📥 Download OK: ${req.params.id}`);
      }
    });
    
  } catch (error) {
    console.error('Erro download:', error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Limpeza mais agressiva
setInterval(async () => {
  const now = Date.now();
  const toDelete = [];
  
  for (const [id, rec] of activeRecordings.entries()) {
    const recordingTime = parseInt(id.split('_')[1]);
    const age = now - recordingTime;
    
    if (age > 5 * 60 * 1000) { // 5 minutos
      toDelete.push(id);
      if (rec.file && fs.existsSync(rec.file)) {
        try {
          await fsPromises.unlink(rec.file);
        } catch (e) {}
      }
    }
  }
  
  toDelete.forEach(id => activeRecordings.delete(id));
  if (toDelete.length > 0) {
    console.log(`🧹 Limpeza: ${toDelete.length} removidos`);
  }
}, 2 * 60 * 1000); // A cada 2 minutos

// Inicialização
async function startServer() {
  try {
    await ensureDownloadsDir();
    
    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Beat Recorder SUPER RÁPIDO na porta ${PORT}`);
      console.log(`⚡ Otimizado para Render - 45s máximo por gravação`);
      console.log(`🎵 10 segundos de áudio, 64kbps`);
    });
    
    server.keepAliveTimeout = 60 * 1000;
    server.headersTimeout = 65 * 1000;
    
  } catch (error) {
    console.error('❌ Erro:', error);
    process.exit(1);
  }
}

startServer(); ao fechar página:', e.message);
      }
    }
    
    if (browser && browser.isConnected()) {
      try {
        await browser.close();
        console.log(`🗂️ Browser fechado: ${info.id}`);
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
      return res.status(400).json({ error: 'URL do YouTube inválida' });
    }
    
    if (activeRecordings.size >= MAX_CONCURRENT) {
      return res.status(429).json({ 
        error: 'Servidor ocupado. Apenas 1 gravação simultânea permitida.',
        activeRecordings: activeRecordings.size
      });
    }
    
    const id = `rec_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const info = {
      id,
      url,
      status: 'queued',
      message: 'Na fila...',
      progress: 0,
      startedAt: new Date().toISOString()
    };
    
    activeRecordings.set(id, info);
    console.log(`🎵 Nova gravação REAL: ${id}`);
    
    // Iniciar gravação
    setImmediate(async () => {
      try {
        await ensureDownloadsDir();
        await realRecording(url, info);
      } catch (error) {
        console.error(`Erro fatal ${id}:`, error);
        info.status = 'error';
        info.error = 'Erro interno: ' + error.message;
      }
    });
    
    res.json({ success: true, recordingId: id });
    
  } catch (error) {
    console.error('Erro no /record:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.get('/status/:id', (req, res) => {
  const info = activeRecordings.get(req.params.id);
  if (!info) {
    return res.status(404).json({ error: 'Gravação não encontrada' });
  }
  res.json(info);
});

app.get('/download/:id', async (req, res) => {
  try {
    const info = activeRecordings.get(req.params.id);
    
    if (!info) {
      return res.status(404).json({ error: 'Gravação não encontrada' });
    }
    
    if (info.status !== 'completed') {
      return res.status(400).json({ 
        error: 'Gravação não concluída',
        status: info.status
      });
    }
    
    if (!info.file || !fs.existsSync(info.file)) {
      return res.status(404).json({ error: 'Arquivo não encontrado' });
    }
    
    const filename = `${info.videoTitle?.replace(/[^\w\s-]/g, '').trim() || 'beat'}_recording.webm`;
    
    res.download(info.file, filename, (err) => {
      if (!err) {
        fsPromises.unlink(info.file).catch(() => {});
        activeRecordings.delete(req.params.id);
        console.log(`📥 Download concluído: ${req.params.id}`);
      }
    });
    
  } catch (error) {
    console.error('Erro no download:', error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Limpeza
setInterval(async () => {
  const now = Date.now();
  const toDelete = [];
  
  for (const [id, rec] of activeRecordings.entries()) {
    const recordingTime = parseInt(id.split('_')[1]);
    const age = now - recordingTime;
    
    if (age > 10 * 60 * 1000) { // 10 minutos
      toDelete.push(id);
      if (rec.file && fs.existsSync(rec.file)) {
        try {
          await fsPromises.unlink(rec.file);
        } catch (e) {}
      }
    }
  }
  
  toDelete.forEach(id => activeRecordings.delete(id));
  if (toDelete.length > 0) {
    console.log(`🧹 Limpeza: ${toDelete.length} gravações antigas`);
  }
}, 5 * 60 * 1000);

// Inicialização
async function startServer() {
  try {
    await ensureDownloadsDir();
    
    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Beat Recorder REAL na porta ${PORT}`);
      console.log(`🎵 Gravação de áudio REAL ativada!`);
      console.log(`📁 Downloads: ${DOWNLOADS_DIR}`);
    });
    
    // Configurar timeouts
    server.keepAliveTimeout = 120 * 1000;
    server.headersTimeout = 125 * 1000;
    
  } catch (error) {
    console.error('❌ Erro ao iniciar:', error);
    process.exit(1);
  }
}

startServer();