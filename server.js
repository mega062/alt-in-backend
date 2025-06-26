// server.js - Gravação REAL de áudio do YouTube
const express = require('express');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const activeRecordings = new Map();
const MAX_CONCURRENT = 1; // Apenas 1 gravação simultânea no Render
const RECORDING_TIMEOUT = 60000; // 1 minuto máximo

// Configuração do Puppeteer
const isProd = process.env.NODE_ENV === 'production';
let puppeteer, getStream;

try {
  puppeteer = require('puppeteer');
  const puppeteerStream = require('puppeteer-stream');
  getStream = puppeteerStream.getStream;
  console.log('✅ Puppeteer e puppeteer-stream carregados com sucesso');
} catch (error) {
  console.error('❌ Erro ao carregar Puppeteer:', error.message);
  process.exit(1);
}

app.use(express.json({ limit: '10mb' }));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    activeRecordings: activeRecordings.size,
    environment: isProd ? 'production' : 'development',
    timestamp: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  res.json({
    message: '🎵 Beat Recorder API - Gravação REAL',
    status: 'online',
    activeRecordings: activeRecordings.size
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
    
    const info = await page.evaluate(() => {
      // Tentar múltiplos seletores para título
      const titleSelectors = [
        'h1.ytd-video-primary-info-renderer yt-formatted-string',
        'h1 yt-formatted-string',
        'h1[data-title]',
        'h1',
        'title'
      ];
      
      let title = 'YouTube Video';
      for (const selector of titleSelectors) {
        const element = document.querySelector(selector);
        if (element && element.textContent) {
          title = element.textContent.trim();
          break;
        }
      }
      
      // Tentar obter autor
      const authorSelectors = [
        '#owner-name a',
        '.ytd-channel-name a',
        'ytd-video-owner-renderer a'
      ];
      
      let author = 'Unknown';
      for (const selector of authorSelectors) {
        const element = document.querySelector(selector);
        if (element && element.textContent) {
          author = element.textContent.trim();
          break;
        }
      }
      
      return { title, author };
    });
    
    return info;
  } catch (error) {
    console.log('⚠️ Erro ao obter info do vídeo:', error.message);
    return { title: 'YouTube Video', author: 'Unknown' };
  }
}

async function realRecording(url, info) {
  let browser = null;
  let page = null;
  let stream = null;
  let timeoutId = null;
  
  try {
    console.log(`🎬 Iniciando gravação REAL: ${info.id}`);
    
    // Timeout de segurança
    timeoutId = setTimeout(() => {
      if (info.status !== 'completed' && info.status !== 'error') {
        console.log(`⏰ Timeout para ${info.id}`);
        info.status = 'error';
        info.error = 'Timeout: Gravação demorou mais que 1 minuto';
      }
    }, RECORDING_TIMEOUT);
    
    info.status = 'opening_browser';
    info.message = 'Abrindo navegador...';
    info.progress = 10;
    
    // Configuração otimizada para Render
    const launchOptions = {
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
        '--autoplay-policy=no-user-gesture-required',
        '--enable-features=WebRTC-HideLocalIpsWithMdns',
        '--disable-audio-output',
        '--mute-audio=false' // Importante para capturar áudio
      ],
      ignoreDefaultArgs: ['--mute-audio'],
      timeout: 30000
    };
    
    // Usar executável específico se em produção
    if (isProd && process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    
    browser = await puppeteer.launch(launchOptions);
    
    info.progress = 20;
    page = await browser.newPage();
    
    // Configurar página para áudio
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 720 });
    
    // Permitir autoplay de áudio
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'mediaDevices', {
        writable: true,
        value: {
          getUserMedia: () => Promise.resolve({
            getTracks: () => [],
            getVideoTracks: () => [],
            getAudioTracks: () => []
          })
        }
      });
    });
    
    info.status = 'loading_video';
    info.message = 'Carregando vídeo do YouTube...';
    info.progress = 30;
    
    console.log(`📺 Navegando para: ${url}`);
    await page.goto(url, { 
      waitUntil: 'networkidle0',
      timeout: 20000 
    });
    
    info.progress = 40;
    
    // Aguardar vídeo carregar
    await page.waitForSelector('video', { timeout: 15000 });
    
    info.progress = 50;
    
    // Obter informações do vídeo
    const videoInfo = await getVideoInfo(page);
    info.videoTitle = videoInfo.title;
    info.videoAuthor = videoInfo.author;
    
    console.log(`🎵 Vídeo: "${videoInfo.title}" por ${videoInfo.author}`);
    
    info.status = 'preparing_recording';
    info.message = 'Preparando para gravar...';
    info.progress = 60;
    
    // Tentar reproduzir o vídeo
    await page.evaluate(async () => {
      const video = document.querySelector('video');
      if (video) {
        video.muted = false;
        video.volume = 1.0;
        
        // Tentar clicar no botão play se existir
        const playButton = document.querySelector('.ytp-large-play-button') || 
                          document.querySelector('.ytp-play-button');
        if (playButton) {
          playButton.click();
        }
        
        try {
          await video.play();
        } catch (e) {
          console.log('Erro ao reproduzir via JS:', e.message);
        }
      }
    });
    
    // Aguardar o vídeo começar
    await page.waitForTimeout(3000);
    
    info.status = 'recording';
    info.message = 'Gravando áudio...';
    info.progress = 70;
    
    const filename = generateFilename();
    const output = path.join(DOWNLOADS_DIR, filename);
    
    console.log(`🔴 Iniciando captura de áudio: ${output}`);
    
    // Configurar stream de áudio
    stream = await getStream(page, { 
      audio: true, 
      video: false,
      mimeType: 'audio/webm;codecs=opus',
      audioBitsPerSecond: 128000 // 128kbps para boa qualidade
    });
    
    const writeStream = fs.createWriteStream(output);
    stream.pipe(writeStream);
    
    info.progress = 80;
    
    // Gravar por 20 segundos
    await new Promise((resolve, reject) => {
      const recordingDuration = 20000; // 20 segundos
      
      const timer = setTimeout(() => {
        console.log(`⏹️ Finalizando gravação de ${info.id}`);
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
      
      // Atualizar progresso
      const progressTimer = setInterval(() => {
        if (info.progress < 90) {
          info.progress += 2;
        }
      }, 1000);
      
      stream.on('end', () => clearInterval(progressTimer));
      stream.on('error', () => clearInterval(progressTimer));
    });
    
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    
    info.status = 'processing';
    info.message = 'Processando arquivo...';
    info.progress = 95;
    
    // Aguardar escrita do arquivo
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Verificar arquivo
    try {
      const stats = await fsPromises.stat(output);
      info.fileSize = Math.round(stats.size / 1024);
      
      if (stats.size < 1000) {
        throw new Error(`Arquivo muito pequeno (${stats.size} bytes) - possível falha na captura`);
      }
      
      console.log(`✅ Arquivo gravado: ${info.fileSize} KB`);
    } catch (statError) {
      throw new Error('Erro ao verificar arquivo: ' + statError.message);
    }
    
    info.status = 'completed';
    info.message = 'Gravação concluída!';
    info.progress = 100;
    info.file = output;
    info.downloadUrl = `/download/${info.id}`;
    
    console.log(`🎉 Gravação REAL concluída: ${info.id} (${info.fileSize} KB)`);
    
  } catch (err) {
    console.error(`❌ Erro na gravação REAL ${info.id}:`, err.message);
    
    if (timeoutId) clearTimeout(timeoutId);
    
    let errorMessage = err.message;
    if (err.message.includes('Session closed') || err.message.includes('Target closed')) {
      errorMessage = 'Navegador foi fechado inesperadamente - tente novamente';
    } else if (err.message.includes('timeout')) {
      errorMessage = 'Timeout - vídeo demorou muito para carregar';
    } else if (err.message.includes('Navigation')) {
      errorMessage = 'Erro ao acessar YouTube - verifique a URL';
    }
    
    info.status = 'error';
    info.error = errorMessage;
    
  } finally {
    // Cleanup
    if (stream && !stream.destroyed) {
      try {
        stream.destroy();
      } catch (e) {
        console.log('Erro ao destruir stream:', e.message);
      }
    }
    
    if (page && !page.isClosed()) {
      try {
        await page.close();
      } catch (e) {
        console.log('Erro ao fechar página:', e.message);
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