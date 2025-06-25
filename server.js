const express = require('express');
const fs = require('fs').promises;
const ytdl = require('ytdl-core');
const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');

const app = express();
const PORT = process.env.PORT || 3000;
const execAsync = promisify(exec);

// ======================================================
// CORS MIDDLEWARE - ADICIONAR ISTO NO SEU SERVIDOR
// ======================================================
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  
  // Responder a requisições OPTIONS (preflight)
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Middleware
app.use(express.json({ limit: '10mb' }));

// Configurações
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const MAX_CONCURRENT_DOWNLOADS = parseInt(process.env.MAX_CONCURRENT || '5');
const MAX_QUEUE_SIZE = parseInt(process.env.MAX_QUEUE_SIZE || '30');
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutos
const QUEUE_TIMEOUT = 10 * 60 * 1000; // 10 minutos na fila

// Sistema de fila
class DownloadQueue extends EventEmitter {
  constructor() {
    super();
    this.queue = new Map(); // Map para facilitar busca por ID
    this.processing = new Set(); // IDs sendo processados
    this.completedItems = new Map(); // Items concluídos para download
    this.stats = {
      totalProcessed: 0,
      totalFailed: 0,
      totalQueued: 0
    };
  }

  // Adicionar item à fila
  enqueue(item) {
    if (this.queue.size >= MAX_QUEUE_SIZE) {
      throw new Error('Fila cheia. Tente novamente mais tarde.');
    }

    const queueItem = {
      ...item,
      id: this.generateId(),
      status: 'queued',
      queuedAt: new Date(),
      position: this.queue.size + 1
    };

    this.queue.set(queueItem.id, queueItem);
    this.stats.totalQueued++;
    
    // Tentar processar imediatamente
    this.processNext();
    
    return queueItem.id;
  }

  // Processar próximo item da fila
  async processNext() {
    if (this.processing.size >= MAX_CONCURRENT_DOWNLOADS) {
      return; // Já temos o máximo de processamentos simultâneos
    }

    // Pegar o primeiro item da fila
    const nextItem = this.getNextQueuedItem();
    if (!nextItem) {
      return; // Fila vazia
    }

    // Mover para processamento
    nextItem.status = 'processing';
    nextItem.startedAt = new Date();
    this.processing.add(nextItem.id);
    
    // Atualizar posições na fila
    this.updateQueuePositions();
    
    this.emit('itemStarted', nextItem);

    try {
      // Processar o download/conversão
      const result = await this.processDownload(nextItem);
      
      // Sucesso
      nextItem.status = 'completed';
      nextItem.completedAt = new Date();
      nextItem.result = result;
      
      // Salvar item concluído para download posterior
      this.completedItems.set(nextItem.id, nextItem);
      
      this.stats.totalProcessed++;
      this.emit('itemCompleted', nextItem);
      
    } catch (error) {
      // Erro no processamento
      nextItem.status = 'failed';
      nextItem.error = error.message;
      nextItem.failedAt = new Date();
      
      this.stats.totalFailed++;
      this.emit('itemFailed', nextItem, error);
    } finally {
      // Remover do processamento
      this.processing.delete(nextItem.id);
      
      // Manter na fila até ser baixado se concluído com sucesso
      if (nextItem.status !== 'completed') {
        this.queue.delete(nextItem.id);
      }
      
      // Processar próximo item
      setTimeout(() => this.processNext(), 100);
    }
  }

  // Obter próximo item para processamento
  getNextQueuedItem() {
    for (const [id, item] of this.queue) {
      if (item.status === 'queued') {
        return item;
      }
    }
    return null;
  }

  // Atualizar posições na fila
  updateQueuePositions() {
    let position = 1;
    for (const [id, item] of this.queue) {
      if (item.status === 'queued') {
        item.position = position++;
      }
    }
  }

  // Obter status de um item
  getItemStatus(id) {
    return this.queue.get(id) || this.completedItems.get(id) || null;
  }

  // Obter item concluído para download
  getCompletedItem(id) {
    return this.completedItems.get(id) || null;
  }

  // Remover item concluído após download
  removeCompletedItem(id) {
    this.completedItems.delete(id);
    this.queue.delete(id);
  }

  // Gerar ID único
  generateId() {
    return crypto.randomBytes(8).toString('hex');
  }

  // Processar download (lógica extraída)
  async processDownload(queueItem) {
    const { youtubeUrl, videoInfo } = queueItem;
    
    console.log(`[${queueItem.id}] Iniciando download: ${videoInfo.title} (${videoInfo.duration}s)`);
    
    const outputFile = await downloadAndConvert(youtubeUrl, DOWNLOADS_DIR);
    
    console.log(`[${queueItem.id}] Conversão concluída: ${path.basename(outputFile)}`);
    
    return {
      outputFile,
      filename: `${videoInfo.title.replace(/[^\w\s-]/g, '').trim()}.wav`
    };
  }

  // Limpar itens antigos da fila
  cleanupQueue() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [id, item] of this.queue) {
      const age = now - item.queuedAt.getTime();
      
      if (age > QUEUE_TIMEOUT) {
        this.queue.delete(id);
        cleaned++;
        
        if (item.status === 'queued') {
          this.emit('itemTimeout', item);
        }
      }
    }
    
    // Limpar items concluídos antigos também
    for (const [id, item] of this.completedItems) {
      const age = now - item.completedAt.getTime();
      
      if (age > QUEUE_TIMEOUT) {
        this.completedItems.delete(id);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      console.log(`Limpeza da fila: ${cleaned} itens removidos`);
      this.updateQueuePositions();
    }
  }

  // Estatísticas da fila
  getStats() {
    const queued = Array.from(this.queue.values()).filter(item => item.status === 'queued').length;
    const processing = this.processing.size;
    
    return {
      ...this.stats,
      currentQueued: queued,
      currentProcessing: processing,
      queueSize: this.queue.size,
      completedItems: this.completedItems.size,
      maxConcurrent: MAX_CONCURRENT_DOWNLOADS,
      maxQueueSize: MAX_QUEUE_SIZE
    };
  }
}

// Instância global da fila
const downloadQueue = new DownloadQueue();

// Controle de downloads simultâneos (mantido para compatibilidade)
let activeDownloads = 0;

// Event listeners da fila
downloadQueue.on('itemStarted', (item) => {
  activeDownloads++;
  console.log(`[${item.id}] Processamento iniciado (${activeDownloads}/${MAX_CONCURRENT_DOWNLOADS})`);
});

downloadQueue.on('itemCompleted', (item) => {
  activeDownloads--;
  console.log(`[${item.id}] Processamento concluído`);
});

downloadQueue.on('itemFailed', (item, error) => {
  activeDownloads--;
  console.error(`[${item.id}] Processamento falhou:`, error.message);
});

downloadQueue.on('itemTimeout', (item) => {
  console.log(`[${item.id}] Item removido da fila por timeout`);
});

// Criar diretório de downloads se não existir
async function ensureDownloadsDir() {
  try {
    await fs.access(DOWNLOADS_DIR);
  } catch {
    await fs.mkdir(DOWNLOADS_DIR, { recursive: true });
  }
}

// Gerar nome único para arquivo
function generateUniqueFilename(extension) {
  const timestamp = Date.now();
  const random = crypto.randomBytes(6).toString('hex');
  return `${timestamp}_${random}.${extension}`;
}

// Limpar arquivos antigos
async function cleanupOldFiles() {
  try {
    const files = await fs.readdir(DOWNLOADS_DIR);
    const now = Date.now();
    const maxAge = 10 * 60 * 1000; // 10 minutos
    
    for (const file of files) {
      const filePath = path.join(DOWNLOADS_DIR, file);
      const stats = await fs.stat(filePath);
      
      if (now - stats.mtime.getTime() > maxAge) {
        await fs.unlink(filePath);
        console.log(`Arquivo removido: ${file}`);
      }
    }
  } catch (error) {
    console.error('Erro na limpeza de arquivos:', error);
  }
}

// Validar URL do YouTube
function validateYouTubeUrl(url) {
  if (!url || typeof url !== 'string') return false;
  
  try {
    return ytdl.validateURL(url);
  } catch {
    return false;
  }
}

// Obter informações do vídeo
async function getVideoInfo(url) {
  try {
    const info = await ytdl.getInfo(url);
    return {
      title: info.videoDetails.title,
      duration: parseInt(info.videoDetails.lengthSeconds),
      author: info.videoDetails.author.name
    };
  } catch (error) {
    throw new Error('Não foi possível obter informações do vídeo');
  }
}

// Download e conversão do áudio
async function downloadAndConvert(youtubeUrl, outputDir) {
  const tempAudioFile = path.join(outputDir, generateUniqueFilename('mp4'));
  const outputFile = path.join(outputDir, generateUniqueFilename('wav'));
  
  return new Promise((resolve, reject) => {
    try {
      // Configurações otimizadas para download
      const audioStream = ytdl(youtubeUrl, {
        filter: 'audioonly',
        quality: 'highestaudio',
        highWaterMark: 1 << 25 // 32MB buffer
      });
      
      const writeStream = require('fs').createWriteStream(tempAudioFile);
      
      // Timeout para downloads muito longos
      const timeout = setTimeout(() => {
        audioStream.destroy();
        writeStream.destroy();
        reject(new Error('Download timeout - vídeo muito longo'));
      }, 10 * 60 * 1000); // 10 minutos
      
      audioStream.pipe(writeStream);
      
      audioStream.on('error', (error) => {
        clearTimeout(timeout);
        writeStream.destroy();
        reject(new Error(`Erro no download: ${error.message}`));
      });
      
      writeStream.on('error', (error) => {
        clearTimeout(timeout);
        reject(new Error(`Erro ao salvar arquivo: ${error.message}`));
      });
      
      writeStream.on('finish', async () => {
        clearTimeout(timeout);
        
        try {
          // Converter para WAV usando FFmpeg com configurações otimizadas
          const ffmpegCommand = `ffmpeg -i "${tempAudioFile}" -acodec pcm_s16le -ar 44100 -ac 2 "${outputFile}"`;
          
          await execAsync(ffmpegCommand, {
            timeout: 5 * 60 * 1000 // 5 minutos timeout
          });
          
          // Remover arquivo temporário
          await fs.unlink(tempAudioFile);
          
          resolve(outputFile);
        } catch (error) {
          // Limpar arquivos em caso de erro
          try {
            await fs.unlink(tempAudioFile);
            await fs.unlink(outputFile);
          } catch {} // Ignorar erros de limpeza
          
          reject(new Error(`Erro na conversão: ${error.message}`));
        }
      });
      
    } catch (error) {
      reject(new Error(`Erro no processo: ${error.message}`));
    }
  });
}

// Endpoint principal
app.post('/convert-youtube', async (req, res) => {
  const { youtubeUrl } = req.body;
  
  console.log('Recebida requisição de conversão:', youtubeUrl);
  
  // Validações
  if (!validateYouTubeUrl(youtubeUrl)) {
    return res.status(400).json({
      error: 'URL inválida do YouTube',
      message: 'Por favor, forneça uma URL válida do YouTube'
    });
  }
  
  try {
    // Obter informações do vídeo
    const videoInfo = await getVideoInfo(youtubeUrl);
    
    // Verificar duração (máximo 30 minutos)
    if (videoInfo.duration > 1800) {
      return res.status(400).json({
        error: 'Vídeo muito longo',
        message: 'Máximo permitido: 30 minutos'
      });
    }
    
    // Adicionar à fila sempre (para manter consistência)
    const queueId = downloadQueue.enqueue({
      youtubeUrl,
      videoInfo
    });
    
    const queueItem = downloadQueue.getItemStatus(queueId);
    
    res.status(202).json({
      success: true,
      message: 'Conversão iniciada',
      queueId: queueId,
      position: queueItem.position,
      estimatedWaitTime: `${Math.ceil(queueItem.position * 2)} minutos`,
      videoTitle: videoInfo.title,
      status: queueItem.status
    });
    
  } catch (error) {
    console.error('Erro no processamento:', error);
    
    res.status(500).json({
      error: 'Erro no processamento',
      message: error.message
    });
  }
});

// Endpoint para verificar status na fila
app.get('/queue/:queueId', (req, res) => {
  const { queueId } = req.params;
  const item = downloadQueue.getItemStatus(queueId);
  
  if (!item) {
    return res.status(404).json({
      error: 'Item não encontrado',
      message: 'ID da fila inválido ou item já foi processado'
    });
  }
  
  res.json({
    id: item.id,
    status: item.status,
    position: item.position || null,
    videoTitle: item.videoInfo.title,
    queuedAt: item.queuedAt,
    startedAt: item.startedAt || null,
    completedAt: item.completedAt || null,
    estimatedWaitTime: item.position ? `${Math.ceil(item.position * 2)} minutos` : null
  });
});

// Endpoint para download do arquivo
app.get('/download/:queueId', async (req, res) => {
  const { queueId } = req.params;
  const item = downloadQueue.getCompletedItem(queueId);
  
  if (!item || item.status !== 'completed') {
    return res.status(404).json({
      error: 'Arquivo não encontrado',
      message: 'Conversão não concluída ou arquivo não disponível'
    });
  }
  
  try {
    const filePath = item.result.outputFile;
    const filename = item.result.filename;
    
    // Verificar se arquivo existe
    await fs.access(filePath);
    
    // Configurar headers para download
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'audio/wav');
    
    // Enviar arquivo
    res.sendFile(filePath, async (err) => {
      if (err) {
        console.error('Erro ao enviar arquivo:', err);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Erro ao enviar arquivo' });
        }
      } else {
        console.log(`[${queueId}] Arquivo enviado com sucesso`);
        
        // Remover item da fila e arquivo do servidor após envio
        downloadQueue.removeCompletedItem(queueId);
        
        try {
          await fs.unlink(filePath);
          console.log(`[${queueId}] Arquivo limpo do servidor`);
        } catch (cleanupError) {
          console.error('Erro ao limpar arquivo:', cleanupError);
        }
      }
    });
    
  } catch (error) {
    console.error('Erro no download:', error);
    res.status(500).json({
      error: 'Erro no download',
      message: error.message
    });
  }
});

// Endpoint de status
app.get('/status', (req, res) => {
  const queueStats = downloadQueue.getStats();
  
  res.json({
    status: 'online',
    activeDownloads,
    queue: queueStats,
    uptime: process.uptime(),
    config: {
      maxConcurrent: MAX_CONCURRENT_DOWNLOADS,
      maxQueueSize: MAX_QUEUE_SIZE
    }
  });
});

// Endpoint de saúde
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    cors: 'enabled'
  });
});

// Middleware de tratamento de erros
app.use((error, req, res, next) => {
  console.error('Erro não tratado:', error);
  res.status(500).json({
    error: 'Erro interno do servidor',
    message: 'Tente novamente mais tarde'
  });
});

// Inicialização do servidor
async function startServer() {
  try {
    await ensureDownloadsDir();
    
    // Configurar limpeza automática
    setInterval(cleanupOldFiles, CLEANUP_INTERVAL);
    setInterval(() => downloadQueue.cleanupQueue(), CLEANUP_INTERVAL);
    
    app.listen(PORT, () => {
      console.log(`🚀 Servidor rodando na porta ${PORT}`);
      console.log(`🌐 CORS habilitado para todas as origens`);
      console.log(`📁 Diretório de downloads: ${DOWNLOADS_DIR}`);
      console.log(`⚡ Máximo de downloads simultâneos: ${MAX_CONCURRENT_DOWNLOADS}`);
      console.log(`📋 Tamanho máximo da fila: ${MAX_QUEUE_SIZE}`);
    });
    
  } catch (error) {
    console.error('Erro ao iniciar servidor:', error);
    process.exit(1);
  }
}

// Tratamento de sinais para encerramento gracioso
process.on('SIGINT', () => {
  console.log('\n🛑 Encerrando servidor...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Encerrando servidor...');
  process.exit(0);
});

startServer();