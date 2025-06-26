// server.js - Versão ultra leve e robusta para Render
const express = require('express');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const activeRecordings = new Map();

// Configuração mínima - sem puppeteer-stream, usando apenas puppeteer
const isProd = process.env.NODE_ENV === 'production';
let puppeteer;

if (isProd) {
  puppeteer = require('puppeteer');
} else {
  puppeteer = require('puppeteer');
}

app.use(express.json({ limit: '10mb' }));

// CORS simplificado
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
    timestamp: new Date().toISOString(),
    activeRecordings: activeRecordings.size,
    environment: isProd ? 'production' : 'development'
  });
});

app.get('/', (req, res) => {
  res.json({
    message: '🎵 Beat Recorder API - Versão Simplificada',
    status: 'funcionando',
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
  return `beat_${stamp}_${rand}.mp3`;
}

async function ensureDownloadsDir() {
  try {
    await fsPromises.access(DOWNLOADS_DIR);
  } catch {
    await fsPromises.mkdir(DOWNLOADS_DIR, { recursive: true });
  }
}

// Função simplificada - apenas captura screenshot e simula gravação
async function simulateRecording(url, info) {
  let browser = null;
  let page = null;
  
  try {
    console.log(`🎬 Iniciando simulação: ${info.id}`);
    info.status = 'opening_browser';
    info.message = 'Abrindo navegador...';
    info.progress = 10;

    // Configuração ultra-minimalista
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
        '--memory-pressure-off'
      ],
      timeout: 15000
    });

    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });

    info.status = 'loading_video';
    info.message = 'Carregando vídeo...';
    info.progress = 30;

    console.log(`📺 Acessando: ${url}`);
    
    // Navegação super rápida
    await page.goto(url, { 
      waitUntil: 'domcontentloaded',
      timeout: 10000 
    });

    info.progress = 50;

    // Tentar obter título
    try {
      const title = await page.evaluate(() => {
        const titleEl = document.querySelector('h1 yt-formatted-string') || 
                       document.querySelector('h1') ||
                       document.querySelector('title');
        return titleEl ? titleEl.textContent.trim() : 'YouTube Video';
      });
      info.videoTitle = title;
    } catch (e) {
      info.videoTitle = 'YouTube Video';
    }

    info.status = 'recording';
    info.message = 'Simulando gravação...';
    info.progress = 70;

    // Simular gravação criando um arquivo de áudio fake
    const filename = generateFilename();
    const output = path.join(DOWNLOADS_DIR, filename);
    
    // Criar um arquivo MP3 fake mínimo (header básico)
    const fakeMP3Data = Buffer.from([
      0xFF, 0xFB, 0x90, 0x00, // MP3 header
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
    ]);
    
    // Repetir para criar um arquivo de ~5KB
    const fullData = Buffer.concat(Array(250).fill(fakeMP3Data));
    await fsPromises.writeFile(output, fullData);

    info.progress = 90;
    
    // Simular processamento
    await new Promise(resolve => setTimeout(resolve, 2000));

    const stats = await fsPromises.stat(output);
    info.fileSize = Math.round(stats.size / 1024);

    info.status = 'completed';
    info.message = 'Simulação concluída!';
    info.progress = 100;
    info.file = output;
    info.downloadUrl = `/download/${info.id}`;

    console.log(`✅ Simulação concluída: ${info.id} (${info.fileSize} KB)`);

  } catch (err) {
    console.error(`❌ Erro na simulação ${info.id}:`, err.message);
    
    info.status = 'error';
    if (err.message.includes('timeout') || err.message.includes('Session closed')) {
      info.error = 'Timeout ou sessão perdida. O Render pode estar limitando recursos.';
    } else {
      info.error = 'Erro na simulação: ' + err.message;
    }
  } finally {
    try {
      if (page) await page.close();
      if (browser) await browser.close();
    } catch (e) {
      console.log('Erro no cleanup:', e.message);
    }
  }
}

// Versão alternativa que funciona sem Puppeteer
async function createDummyRecording(url, info) {
  try {
    console.log(`🎵 Criando gravação dummy para: ${info.id}`);
    
    info.status = 'loading_video';
    info.message = 'Processando URL...';
    info.progress = 20;
    
    // Extrair ID do vídeo da URL
    const videoIdMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    const videoId = videoIdMatch ? videoIdMatch[1] : 'unknown';
    
    info.videoTitle = `YouTube Video - ${videoId}`;
    info.progress = 50;
    
    info.status = 'recording';
    info.message = 'Criando arquivo de demonstração...';
    info.progress = 70;
    
    // Criar arquivo de demonstração
    const filename = generateFilename();
    const output = path.join(DOWNLOADS_DIR, filename);
    
    // Criar um arquivo de texto que simula um beat
    const demoContent = `# Beat Recorder Demo File
# URL: ${url}
# Video ID: ${videoId}
# Timestamp: ${new Date().toISOString()}
# 
# Este é um arquivo de demonstração.
# Em produção, aqui estaria o áudio gravado do YouTube.
# 
# Para testar o download, este arquivo serve como placeholder.`;

    await fsPromises.writeFile(output, demoContent, 'utf8');
    
    info.progress = 90;
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const stats = await fsPromises.stat(output);
    info.fileSize = Math.round(stats.size / 1024);
    
    info.status = 'completed';
    info.message = 'Arquivo demo criado!';
    info.progress = 100;
    info.file = output;
    info.downloadUrl = `/download/${info.id}`;
    
    console.log(`✅ Demo criado: ${info.id} (${info.fileSize} KB)`);
    
  } catch (err) {
    console.error(`❌ Erro no demo ${info.id}:`, err.message);
    info.status = 'error';
    info.error = 'Erro ao criar arquivo demo: ' + err.message;
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
    
    if (activeRecordings.size >= 2) {
      return res.status(429).json({ 
        error: 'Servidor ocupado. Tente novamente em alguns minutos.'
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
    console.log(`🎵 Nova solicitação: ${id}`);
    
    // Tentar primeiro com Puppeteer, se falhar usar dummy
    setImmediate(async () => {
      try {
        await ensureDownloadsDir();
        
        if (isProd) {
          // Em produção, tentar Puppeteer mas com fallback
          try {
            await simulateRecording(url, info);
          } catch (puppeteerError) {
            console.log('Puppeteer falhou, usando fallback dummy...');
            await createDummyRecording(url, info);
          }
        } else {
          // Em desenvolvimento, usar Puppeteer
          await simulateRecording(url, info);
        }
      } catch (err) {
        console.error(`Erro fatal ${id}:`, err);
        info.status = 'error';
        info.error = 'Erro interno do servidor';
      }
    });
    
    res.json({ success: true, recordingId: id });
    
  } catch (error) {
    console.error('Erro no endpoint /record:', error);
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
        error: 'Gravação ainda não foi concluída',
        status: info.status
      });
    }
    
    if (!info.file || !fs.existsSync(info.file)) {
      return res.status(404).json({ error: 'Arquivo não encontrado' });
    }
    
    const filename = `${info.videoTitle?.replace(/[^\w\s-]/g, '').trim() || 'beat'}_demo.txt`;
    
    res.download(info.file, filename, (err) => {
      if (!err) {
        fsPromises.unlink(info.file).catch(() => {});
        activeRecordings.delete(req.params.id);
        console.log(`📥 Download concluído: ${req.params.id}`);
      }
    });
    
  } catch (error) {
    console.error('Erro no download:', error);
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
    console.log(`🧹 Limpeza: ${toDelete.length} itens removidos`);
  }
}, 2 * 60 * 1000);

// Inicialização
async function startServer() {
  try {
    await ensureDownloadsDir();
    
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Servidor LEVE rodando na porta ${PORT}`);
      console.log(`🎵 Modo: ${isProd ? 'Produção (com fallback)' : 'Desenvolvimento'}`);
      console.log(`📁 Dir: ${DOWNLOADS_DIR}`);
    });
  } catch (error) {
    console.error('❌ Erro ao iniciar:', error);
    process.exit(1);
  }
}

startServer();