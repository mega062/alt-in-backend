const express = require('express');
const fs = require('fs').promises;
const ytdl = require('ytdl-core');
const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');

// Desabilitar verificação de updates do ytdl-core
process.env.YTDL_NO_UPDATE = 'true';

const app = express();
const PORT = process.env.PORT || 3000;
const execAsync = promisify(exec);

// ======================================================
// CORS MIDDLEWARE
// ======================================================
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  
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
    this.queue = new Map();
    this.processing = new Set();
    this.completedItems = new Map();
    this.stats = {
      totalProcessed: 0,
      totalFailed: 0,
      totalQueued: 0
    };
  }

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
    
    this.processNext();
    
    return queueItem.id;
  }

  async processNext() {
    if (this.processing.size >= MAX_CONCURRENT_DOWNLOADS) {
      return;
    }

    const nextItem = this.getNextQueuedItem();
    if (!nextItem) {
      return;
    }

    nextItem.status = 'processing';
    nextItem.startedAt = new Date();
    this.processing.add(nextItem.id);
    
    this.updateQueuePositions();
    this.emit('itemStarted', nextItem);

    try {
      const result = await this.processDownload(nextItem);
      
      nextItem.status = 'completed';
      nextItem.completedAt = new Date();
      nextItem.result = result;
      
      this.completedItems.set(nextItem.id, nextItem);
      this.stats.totalProcessed++;
      this.emit('itemCompleted', nextItem);
      
    } catch (error) {
      nextItem.status = 'failed';
      nextItem.error = error.message;
      nextItem.failedAt = new Date();
      
      this.stats.totalFailed++;
      this.emit('itemFailed', nextItem, error);
    } finally {
      this.processing.delete(nextItem.id);
      
      if (nextItem.status !== 'completed') {
        this.queue.delete(nextItem.id);
      }
      
      setTimeout(() => this.processNext(), 100);
    }
  }

  getNextQueuedItem() {
    for (const [id, item] of this.queue) {
      if (item.status === 'queued') {
        return item;
      }
    }
    return null;
  }

  updateQueuePositions() {
    let position = 1;
    for (const [id, item] of this.queue) {
      if (item.status === 'queued') {
        item.position = position++;
      }
    }
  }

  getItemStatus(id) {
    return this.queue.get(id) || this.completedItems.get(id) || null;
  }

  getCompletedItem(id) {
    return this.completedItems.get(id) || null;
  }

  removeCompletedItem(id) {
    this.completedItems.delete(id);
    this.queue.delete(id);
  }

  generateId() {
    return crypto.randomBytes(8).toString('hex');
  }

  async processDownload(queueItem) {
    const { youtubeUrl, videoInfo } = queueItem;
    
    console.log(`[${queueItem.id}] Iniciando download: ${videoInfo.title} (${videoInfo.duration}s)`);
    
    // Usar estratégia múltipla
    const outputFile = await downloadAndConvertAdvanced(youtubeUrl, DOWNLOADS_DIR);
    
    console.log(`[${queueItem.id}] Conversão concluída: ${path.basename(outputFile)}`);
    
    return {
      outputFile,
      filename: `${videoInfo.title.replace(/[^\w\s-]/g, '').trim()}.wav`
    };
  }

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

// Controle de downloads simultâneos
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

// Função para baixar yt-dlp se não existir
async function ensureYtDlp() {
  try {
    const ytDlpPath = path.join(__dirname, 'yt-dlp');
    
    try {
      await fs.access(ytDlpPath);
      console.log('yt-dlp já está disponível');
      return ytDlpPath;
    } catch {
      console.log('Baixando yt-dlp...');
      
      // Baixar yt-dlp
      await execAsync(`curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o ${ytDlpPath}`);
      await execAsync(`chmod +x ${ytDlpPath}`);
      
      console.log('yt-dlp baixado com sucesso');
      return ytDlpPath;
    }
  } catch (error) {
    console.error('Erro ao configurar yt-dlp:', error);
    throw new Error('yt-dlp não disponível');
  }
}

// Obter informações do vídeo usando yt-dlp
async function getVideoInfoWithYtDlp(url) {
  try {
    console.log('Obtendo informações com yt-dlp...');
    
    const ytDlpPath = await ensureYtDlp();
    const cleanUrl = url.split('&list=')[0].split('&start_radio=')[0];
    
    // Comando para obter apenas informações
    const infoCommand = `${ytDlpPath} --dump-json --no-download "${cleanUrl}"`;
    
    const { stdout } = await execAsync(infoCommand, {
      timeout: 30000 // 30 segundos
    });
    
    const info = JSON.parse(stdout);
    
    return {
      title: info.title || 'Unknown',
      duration: parseInt(info.duration) || 300,
      author: info.uploader || info.channel || 'Unknown'
    };
    
  } catch (error) {
    console.error('Erro ao obter info com yt-dlp:', error);
    throw error;
  }
}

// Obter informações do vídeo com fallbacks melhorados
async function getVideoInfo(url) {
  try {
    console.log(`Obtendo informações do vídeo: ${url}`);
    
    // Limpar URL de parâmetros desnecessários
    const cleanUrl = url.split('&list=')[0].split('&start_radio=')[0];
    console.log(`URL limpa: ${cleanUrl}`);
    
    // Primeira tentativa - método padrão com configurações melhoradas
    const info = await ytdl.getInfo(cleanUrl, {
      requestOptions: {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate',
          'DNT': '1',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
        }
      }
    });
    
    return {
      title: info.videoDetails.title,
      duration: parseInt(info.videoDetails.lengthSeconds),
      author: info.videoDetails.author.name
    };
  } catch (error) {
    console.log(`ytdl-core falhou: ${error.message}`);
    
    // Fallback para yt-dlp
    try {
      return await getVideoInfoWithYtDlp(url);
    } catch (error2) {
      console.log(`yt-dlp falhou: ${error2.message}`);
      
      // Fallback final - usar informações mínimas extraídas da URL
      const cleanUrl = url.split('&list=')[0].split('&start_radio=')[0];
      const videoId = extractVideoId(cleanUrl);
      return {
        title: `YouTube Video ${videoId}`,
        duration: 300, // 5 minutos como estimativa
        author: 'Unknown'
      };
    }
  }
}

// Extrair ID do vídeo da URL
function extractVideoId(url) {
  const regex = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#]+)/;
  const match = url.match(regex);
  return match ? match[1] : 'unknown';
}

// Validar URL do YouTube com mais robustez
function validateYouTubeUrl(url) {
  if (!url || typeof url !== 'string') return false;
  
  try {
    const regex = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|embed\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
    if (!regex.test(url)) return false;
    
    return ytdl.validateURL(url);
  } catch (error) {
    console.log(`Erro na validação: ${error.message}`);
    
    const regex = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|embed\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
    return regex.test(url);
  }
}

// Download usando yt-dlp
async function downloadWithYtDlp(youtubeUrl, outputDir) {
  try {
    console.log('🔄 Estratégia 2: Tentando com yt-dlp...');
    
    const ytDlpPath = await ensureYtDlp();
    const cleanUrl = youtubeUrl.split('&list=')[0].split('&start_radio=')[0];
    const outputFile = path.join(outputDir, generateUniqueFilename('wav'));
    
    // Comando yt-dlp para extrair áudio diretamente como WAV
    const ytDlpCommand = `${ytDlpPath} --extract-audio --audio-format wav --audio-quality 0 --output "${outputFile.replace('.wav', '.%(ext)s')}" "${cleanUrl}"`;
    
    console.log('Executando yt-dlp...');
    await execAsync(ytDlpCommand, {
      timeout: 15 * 60 * 1000 // 15 minutos timeout
    });
    
    // Encontrar o arquivo gerado (yt-dlp pode mudar o nome)
    const files = await fs.readdir(outputDir);
    const generatedFile = files.find(file => 
      file.includes(path.basename(outputFile, '.wav')) && file.endsWith('.wav')
    );
    
    if (!generatedFile) {
      throw new Error('Arquivo não foi gerado pelo yt-dlp');
    }
    
    const finalFile = path.join(outputDir, generatedFile);
    console.log(`✅ yt-dlp concluído: ${path.basename(finalFile)}`);
    
    return finalFile;
    
  } catch (error) {
    console.error('❌ Erro com yt-dlp:', error);
    throw new Error(`yt-dlp falhou: ${error.message}`);
  }
}

// Download e conversão do áudio com múltiplos fallbacks
async function downloadAndConvert(youtubeUrl, outputDir) {
  const tempAudioFile = path.join(outputDir, generateUniqueFilename('mp4'));
  const outputFile = path.join(outputDir, generateUniqueFilename('wav'));
  
  // Limpar URL
  const cleanUrl = youtubeUrl.split('&list=')[0].split('&start_radio=')[0];
  
  return new Promise((resolve, reject) => {
    try {
      console.log(`🔄 Estratégia 1: Tentando com ytdl-core...`);
      console.log(`Iniciando download de: ${cleanUrl}`);
      
      // Configurações otimizadas para download com múltiplos fallbacks
      const downloadOptions = {
        filter: 'audioonly',
        quality: 'highestaudio',
        highWaterMark: 1 << 25, // 32MB buffer
        requestOptions: {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Cookie': 'CONSENT=YES+cb.20210328-17-p0.en+FX+667;',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://www.youtube.com/',
            'Origin': 'https://www.youtube.com'
          }
        }
      };
      
      let audioStream;
      let attempt = 0;
      const maxAttempts = 3;
      
      const tryDownload = () => {
        attempt++;
        console.log(`Tentativa de download ${attempt}/${maxAttempts}`);
        
        try {
          audioStream = ytdl(cleanUrl, downloadOptions);
          const writeStream = require('fs').createWriteStream(tempAudioFile);
          
          // Timeout para downloads muito longos
          const timeout = setTimeout(() => {
            if (audioStream) audioStream.destroy();
            if (writeStream) writeStream.destroy();
            
            if (attempt < maxAttempts) {
              console.log(`Timeout na tentativa ${attempt}, tentando novamente...`);
              setTimeout(tryDownload, 2000); // Esperar 2s antes de tentar novamente
            } else {
              reject(new Error('Download timeout após múltiplas tentativas'));
            }
          }, 10 * 60 * 1000); // 10 minutos
          
          audioStream.pipe(writeStream);
          
          audioStream.on('error', (error) => {
            clearTimeout(timeout);
            writeStream.destroy();
            console.error(`Erro no stream de áudio (tentativa ${attempt}):`, error.message);
            
            if (attempt < maxAttempts && (error.statusCode === 410 || error.statusCode === 403)) {
              console.log(`Tentando novamente com configurações diferentes...`);
              
              // Mudar configurações para próxima tentativa
              downloadOptions.requestOptions.headers['User-Agent'] = 
                `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36`;
              
              setTimeout(tryDownload, 3000); // Esperar 3s
            } else {
              reject(new Error(`Erro no download após ${attempt} tentativas: ${error.message}`));
            }
          });
          
          audioStream.on('info', (info) => {
            console.log(`Download iniciado: ${info.videoDetails.title}`);
          });
          
          audioStream.on('progress', (chunkLength, downloaded, total) => {
            const percent = downloaded / total;
            if (percent % 0.1 < 0.01) { // Log a cada 10%
              console.log(`Download progress: ${(percent * 100).toFixed(1)}%`);
            }
          });
          
          writeStream.on('finish', async () => {
            clearTimeout(timeout);
            console.log('Download concluído, iniciando conversão...');
            
            try {
              // Verificar se arquivo foi baixado
              const stats = await fs.stat(tempAudioFile);
              if (stats.size === 0) {
                throw new Error('Arquivo baixado está vazio');
              }
              
              console.log(`Arquivo baixado: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
              
              // Converter para WAV usando FFmpeg
              const ffmpegCommand = `ffmpeg -i "${tempAudioFile}" -acodec pcm_s16le -ar 44100 -ac 2 "${outputFile}"`;
              
              console.log('Executando FFmpeg...');
              await execAsync(ffmpegCommand, {
                timeout: 10 * 60 * 1000 // 10 minutos timeout
              });
              
              // Verificar se conversão foi bem-sucedida
              const convertedStats = await fs.stat(outputFile);
              if (convertedStats.size === 0) {
                throw new Error('Conversão resultou em arquivo vazio');
              }
              
              console.log(`✅ Conversão concluída: ${(convertedStats.size / 1024 / 1024).toFixed(2)} MB`);
              
              // Remover arquivo temporário
              await fs.unlink(tempAudioFile);
              
              resolve(outputFile);
            } catch (error) {
              console.error('Erro na conversão:', error);
              
              // Limpar arquivos em caso de erro
              try {
                await fs.unlink(tempAudioFile);
                await fs.unlink(outputFile);
              } catch {} // Ignorar erros de limpeza
              
              reject(new Error(`Erro na conversão: ${error.message}`));
            }
          });
          
          writeStream.on('error', (error) => {
            clearTimeout(timeout);
            console.error(`Erro no stream de escrita (tentativa ${attempt}):`, error);
            
            if (attempt < maxAttempts) {
              setTimeout(tryDownload, 2000);
            } else {
              reject(new Error(`Erro ao salvar arquivo: ${error.message}`));
            }
          });
          
        } catch (error) {
          console.error(`Erro geral na tentativa ${attempt}:`, error);
          
          if (attempt < maxAttempts) {
            setTimeout(tryDownload, 3000);
          } else {
            reject(new Error(`Erro no processo após ${attempt} tentativas: ${error.message}`));
          }
        }
      };
      
      tryDownload();
      
    } catch (error) {
      console.error('Erro crítico no download:', error);
      reject(new Error(`Erro crítico: ${error.message}`));
    }
  });
}

// Função principal com estratégias múltiplas
async function downloadAndConvertAdvanced(youtubeUrl, outputDir) {
  const cleanUrl = youtubeUrl.split('&list=')[0].split('&start_radio=')[0];
  
  // Estratégia 1: Tentar ytdl-core primeiro
  try {
    return await downloadAndConvert(youtubeUrl, outputDir);
  } catch (error) {
    console.log(`❌ ytdl-core falhou: ${error.message}`);
  }
  
  // Estratégia 2: Usar yt-dlp como fallback
  try {
    return await downloadWithYtDlp(cleanUrl, outputDir);
  } catch (error) {
    console.log(`❌ yt-dlp falhou: ${error.message}`);
  }
  
  throw new Error('❌ Todas as estratégias de download falharam');
}

// Endpoint principal
app.post('/convert-youtube', async (req, res) => {
  const { youtubeUrl } = req.body;
  
  console.log('='.repeat(50));
  console.log('Recebida requisição de conversão:', youtubeUrl);
  console.log('Timestamp:', new Date().toISOString());
  
  // Validações
  if (!validateYouTubeUrl(youtubeUrl)) {
    console.log('URL inválida:', youtubeUrl);
    return res.status(400).json({
      error: 'URL inválida do YouTube',
      message: 'Por favor, forneça uma URL válida do YouTube'
    });
  }
  
  try {
    console.log('Obtendo informações do vídeo...');
    
    // Obter informações do vídeo com fallbacks
    const videoInfo = await getVideoInfo(youtubeUrl);
    console.log('Informações obtidas:', videoInfo);
    
    // Verificar duração (máximo 30 minutos)
    if (videoInfo.duration > 1800) {
      console.log('Vídeo muito longo:', videoInfo.duration, 'segundos');
      return res.status(400).json({
        error: 'Vídeo muito longo',
        message: `Duração: ${Math.round(videoInfo.duration/60)} minutos. Máximo permitido: 30 minutos`
      });
    }
    
    console.log('Adicionando à fila de processamento...');
    
    // Adicionar à fila
    const queueId = downloadQueue.enqueue({
      youtubeUrl,
      videoInfo
    });
    
    const queueItem = downloadQueue.getItemStatus(queueId);
    console.log(`Item adicionado à fila com ID: ${queueId}, posição: ${queueItem.position}`);
    
    res.status(202).json({
      success: true,
      message: 'Conversão iniciada com sucesso',
      queueId: queueId,
      position: queueItem.position,
      estimatedWaitTime: `${Math.ceil(queueItem.position * 2)} minutos`,
      videoTitle: videoInfo.title,
      videoAuthor: videoInfo.author,
      videoDuration: videoInfo.duration,
      status: queueItem.status
    });
    
  } catch (error) {
    console.error('Erro no processamento:', error.message);
    console.error('Stack:', error.stack);
    
    // Retornar erro mais específico
    let errorMessage = error.message;
    let errorCode = 500;
    
    if (error.message.includes('Video unavailable')) {
      errorMessage = 'Vídeo não disponível ou privado';
      errorCode = 404;
    } else if (error.message.includes('Sign in to confirm your age')) {
      errorMessage = 'Vídeo com restrição de idade - não é possível processar';
      errorCode = 403;
    } else if (error.message.includes('This live event')) {
      errorMessage = 'Não é possível processar lives ou premieres';
      errorCode = 400;
    } else if (error.message.includes('Private video')) {
      errorMessage = 'Vídeo privado - não é possível acessar';
      errorCode = 403;
    }
    
    res.status(errorCode).json({
      error: 'Erro no processamento',
      message: errorMessage,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
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
    
    // Tentar configurar yt-dlp na inicialização
    try {
      await ensureYtDlp();
      console.log('✅ yt-dlp configurado com sucesso');
    } catch (error) {
      console.log('⚠️  yt-dlp não disponível, usando apenas ytdl-core');
    }
    
    // Configurar limpeza automática
    setInterval(cleanupOldFiles, CLEANUP_INTERVAL);
    setInterval(() => downloadQueue.cleanupQueue(), CLEANUP_INTERVAL);
    
    app.listen(PORT, () => {
      console.log(`🚀 Servidor rodando na porta ${PORT}`);
      console.log(`🌐 CORS habilitado para todas as origens`);
      console.log(`📁 Diretório de downloads: ${DOWNLOADS_DIR}`);
      console.log(`⚡ Máximo de downloads simultâneos: ${MAX_CONCURRENT_DOWNLOADS}`);
      console.log(`📋 Tamanho máximo da fila: ${MAX_QUEUE_SIZE}`);
      console.log(`🔧 Estratégias: ytdl-core + yt-dlp fallback`);
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