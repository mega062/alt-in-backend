// server.js - Versão à prova de falhas para Render
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;

// Configuração robusta
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// CORS permissivo
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Sistema de simulação de gravação (sem Puppeteer)
const activeRecordings = new Map();
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');

// Garantir que o diretório existe
try {
  if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  }
} catch (err) {
  console.error('Erro ao criar diretório:', err);
}

// Endpoints de health check
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    message: '🎵 Beat Recorder API funcionando!',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    activeRecordings: activeRecordings.size
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString(),
    activeRecordings: activeRecordings.size
  });
});

// Endpoint de teste para debug
app.get('/test', (req, res) => {
  res.json({
    message: 'Endpoint de teste funcionando!',
    headers: req.headers,
    method: req.method,
    url: req.url,
    timestamp: new Date().toISOString()
  });
});

function validateYouTubeUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const regex = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|embed\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
  return regex.test(url);
}

function extractVideoId(url) {
  const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : 'unknown';
}

function generateFilename() {
  const timestamp = Date.now();
  const random = crypto.randomBytes(4).toString('hex');
  return `beat_${timestamp}_${random}.mp3`;
}

// Simular gravação sem usar Puppeteer
async function simulateRecording(url, info) {
  return new Promise((resolve) => {
    console.log(`🎵 Simulando gravação: ${info.id}`);
    
    const videoId = extractVideoId(url);
    
    // Simular etapas da gravação
    const steps = [
      { status: 'opening_browser', message: 'Conectando ao YouTube...', progress: 10, delay: 1000 },
      { status: 'loading_video', message: 'Carregando vídeo...', progress: 30, delay: 1500 },
      { status: 'preparing_recording', message: 'Preparando gravação...', progress: 50, delay: 1000 },
      { status: 'recording', message: 'Gravando áudio...', progress: 80, delay: 3000 },
      { status: 'processing', message: 'Processando arquivo...', progress: 95, delay: 1000 }
    ];
    
    let currentStep = 0;
    
    function nextStep() {
      if (currentStep < steps.length) {
        const step = steps[currentStep];
        info.status = step.status;
        info.message = step.message;
        info.progress = step.progress;
        
        console.log(`📝 ${info.id}: ${step.message} (${step.progress}%)`);
        
        setTimeout(() => {
          currentStep++;
          nextStep();
        }, step.delay);
      } else {
        // Criar arquivo de demonstração
        createDemoFile(info, videoId).then(() => {
          resolve();
        });
      }
    }
    
    nextStep();
  });
}

async function createDemoFile(info, videoId) {
  try {
    const filename = generateFilename();
    const filePath = path.join(DOWNLOADS_DIR, filename);
    
    // Criar conteúdo de demonstração
    const demoContent = `# Beat Recorder - Arquivo de Demonstração
# 
# ID da Gravação: ${info.id}
# Video ID: ${videoId}
# URL: ${info.url}
# Timestamp: ${new Date().toISOString()}
# 
# Este é um arquivo de demonstração do Beat Recorder.
# Em um ambiente de produção completo, aqui estaria o áudio
# gravado diretamente do YouTube.
# 
# O sistema está funcionando corretamente!
# 
# Para testar o download, este arquivo serve como placeholder.
# Tamanho do arquivo: ${Math.floor(Math.random() * 5000 + 1000)} bytes simulados
# Duração simulada: ${Math.floor(Math.random() * 180 + 30)} segundos
# 
# Beat Recorder v1.0 - Funcionando! 🎵
`;

    // Escrever arquivo
    fs.writeFileSync(filePath, demoContent, 'utf8');
    
    // Verificar se foi criado
    const stats = fs.statSync(filePath);
    
    info.file = filePath;
    info.fileSize = Math.round(stats.size / 1024); // KB
    info.videoTitle = `YouTube Video - ${videoId}`;
    info.videoAuthor = 'Demo Channel';
    info.status = 'completed';
    info.message = 'Gravação de demonstração concluída!';
    info.progress = 100;
    info.downloadUrl = `/download/${info.id}`;
    
    console.log(`✅ Demo criado: ${info.id} (${info.fileSize} KB)`);
    
  } catch (error) {
    console.error(`❌ Erro ao criar demo: ${error.message}`);
    info.status = 'error';
    info.error = 'Erro ao criar arquivo de demonstração: ' + error.message;
  }
}

// Endpoint principal de gravação
app.post('/record', async (req, res) => {
  try {
    console.log('📥 Nova solicitação de gravação recebida');
    console.log('Body:', req.body);
    
    const { url } = req.body;
    
    // Validações
    if (!url) {
      console.log('❌ URL não fornecida');
      return res.status(400).json({ 
        error: 'URL é obrigatória',
        received: req.body
      });
    }
    
    if (!validateYouTubeUrl(url)) {
      console.log('❌ URL inválida:', url);
      return res.status(400).json({ 
        error: 'URL do YouTube inválida',
        url: url
      });
    }
    
    // Limitar gravações simultâneas
    if (activeRecordings.size >= 3) {
      console.log('❌ Servidor ocupado');
      return res.status(429).json({ 
        error: 'Servidor ocupado. Máximo 3 gravações simultâneas.',
        activeRecordings: activeRecordings.size
      });
    }
    
    // Criar nova gravação
    const id = `rec_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const info = {
      id,
      url,
      status: 'queued',
      message: 'Na fila de gravação...',
      progress: 0,
      startedAt: new Date().toISOString()
    };
    
    activeRecordings.set(id, info);
    console.log(`🎵 Nova gravação criada: ${id}`);
    
    // Iniciar gravação assíncrona
    setImmediate(async () => {
      try {
        await simulateRecording(url, info);
      } catch (error) {
        console.error(`❌ Erro na gravação ${id}:`, error);
        info.status = 'error';
        info.error = 'Erro interno durante a gravação: ' + error.message;
      }
    });
    
    // Resposta imediata
    res.json({ 
      success: true, 
      recordingId: id,
      message: 'Gravação iniciada com sucesso',
      statusUrl: `/status/${id}`
    });
    
  } catch (error) {
    console.error('❌ Erro no endpoint /record:', error);
    res.status(500).json({ 
      error: 'Erro interno do servidor',
      details: error.message
    });
  }
});

// Status da gravação
app.get('/status/:id', (req, res) => {
  try {
    const id = req.params.id;
    const info = activeRecordings.get(id);
    
    if (!info) {
      return res.status(404).json({ 
        error: 'Gravação não encontrada',
        id: id
      });
    }
    
    console.log(`📊 Status solicitado para: ${id} - ${info.status}`);
    res.json(info);
    
  } catch (error) {
    console.error('❌ Erro no endpoint /status:', error);
    res.status(500).json({ 
      error: 'Erro interno do servidor',
      details: error.message
    });
  }
});

// Download do arquivo
app.get('/download/:id', (req, res) => {
  try {
    const id = req.params.id;
    const info = activeRecordings.get(id);
    
    console.log(`📥 Download solicitado para: ${id}`);
    
    if (!info) {
      return res.status(404).json({ 
        error: 'Gravação não encontrada',
        id: id
      });
    }
    
    if (info.status !== 'completed') {
      return res.status(400).json({ 
        error: 'Gravação ainda não foi concluída',
        status: info.status,
        progress: info.progress
      });
    }
    
    if (!info.file || !fs.existsSync(info.file)) {
      return res.status(404).json({ 
        error: 'Arquivo não encontrado no servidor',
        file: info.file
      });
    }
    
    const filename = `${info.videoTitle?.replace(/[^\w\s-]/g, '').trim() || 'beat'}_demo.txt`;
    
    console.log(`📦 Enviando arquivo: ${filename}`);
    
    res.download(info.file, filename, (err) => {
      if (err) {
        console.error(`❌ Erro no download ${id}:`, err);
      } else {
        console.log(`✅ Download concluído: ${id}`);
        // Limpar arquivo após download
        try {
          fs.unlinkSync(info.file);
          activeRecordings.delete(id);
        } catch (cleanupErr) {
          console.error('Erro na limpeza:', cleanupErr);
        }
      }
    });
    
  } catch (error) {
    console.error('❌ Erro no endpoint /download:', error);
    res.status(500).json({ 
      error: 'Erro interno do servidor',
      details: error.message
    });
  }
});

// Listar gravações ativas (debug)
app.get('/recordings', (req, res) => {
  const recordings = Array.from(activeRecordings.entries()).map(([id, info]) => ({
    id,
    status: info.status,
    progress: info.progress,
    startedAt: info.startedAt
  }));
  
  res.json({
    activeRecordings: recordings.length,
    recordings: recordings
  });
});

// Limpeza periódica
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [id, rec] of activeRecordings.entries()) {
    const recordingTime = parseInt(id.split('_')[1]);
    const age = now - recordingTime;
    
    // Limpar gravações com mais de 10 minutos
    if (age > 10 * 60 * 1000) {
      try {
        if (rec.file && fs.existsSync(rec.file)) {
          fs.unlinkSync(rec.file);
        }
        activeRecordings.delete(id);
        cleaned++;
      } catch (err) {
        console.error('Erro na limpeza:', err);
      }
    }
  }
  
  if (cleaned > 0) {
    console.log(`🧹 Limpeza automática: ${cleaned} gravações antigas removidas`);
  }
}, 5 * 60 * 1000); // A cada 5 minutos

// Tratamento de erros globais
process.on('uncaughtException', (err) => {
  console.error('❌ Exceção não capturada:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Promise rejeitada:', reason);
});

// Inicialização do servidor
function startServer() {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Beat Recorder Server ONLINE!`);
    console.log(`📡 Porta: ${PORT}`);
    console.log(`📁 Downloads: ${DOWNLOADS_DIR}`);
    console.log(`🌍 Ambiente: ${process.env.NODE_ENV || 'development'}`);
    console.log(`⏰ Iniciado em: ${new Date().toISOString()}`);
    console.log(`🎵 Pronto para receber gravações!`);
  });

  // Configurar timeouts do servidor
  server.keepAliveTimeout = 120 * 1000; // 120 segundos
  server.headersTimeout = 125 * 1000;   // 125 segundos
  
  return server;
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('📴 Recebido SIGTERM, iniciando shutdown...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('📴 Recebido SIGINT, iniciando shutdown...');
  process.exit(0);
});

startServer();