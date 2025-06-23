const express = require('express');
const fs = require('fs').promises;
const ytdl = require('ytdl-core');
const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const execAsync = promisify(exec);

// Middleware
app.use(express.json({ limit: '10mb' }));

// Configurações
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const MAX_CONCURRENT_DOWNLOADS = 3;
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutos

// Controle de downloads simultâneos
let activeDownloads = 0;

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
  
  // Validações
  if (!validateYouTubeUrl(youtubeUrl)) {
    return res.status(400).json({
      error: 'URL inválida do YouTube',
      message: 'Por favor, forneça uma URL válida do YouTube'
    });
  }
  
  // Controle de limite de downloads simultâneos
  if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
    return res.status(429).json({
      error: 'Muitas requisições',
      message: 'Tente novamente em alguns momentos'
    });
  }
  
  activeDownloads++;
  
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
    
    console.log(`Iniciando download: ${videoInfo.title} (${videoInfo.duration}s)`);
    
    // Download e conversão
    const outputFile = await downloadAndConvert(youtubeUrl, DOWNLOADS_DIR);
    
    // Obter informações do arquivo final
    const stats = await fs.stat(outputFile);
    const filename = `${videoInfo.title.replace(/[^\w\s-]/g, '').trim()}.wav`;
    
    console.log(`Conversão concluída: ${path.basename(outputFile)}`);
    
    // Enviar arquivo para download
    res.download(outputFile, filename, async (err) => {
      if (err) {
        console.error('Erro ao enviar arquivo:', err);
      }
      
      // Limpar arquivo após envio
      try {
        await fs.unlink(outputFile);
      } catch (cleanupError) {
        console.error('Erro ao limpar arquivo:', cleanupError);
      }
    });
    
  } catch (error) {
    console.error('Erro no processamento:', error);
    
    res.status(500).json({
      error: 'Erro no processamento',
      message: error.message
    });
  } finally {
    activeDownloads--;
  }
});

// Endpoint de status
app.get('/status', (req, res) => {
  res.json({
    status: 'online',
    activeDownloads,
    maxConcurrent: MAX_CONCURRENT_DOWNLOADS,
    uptime: process.uptime()
  });
});

// Endpoint de saúde
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
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
    
    app.listen(PORT, () => {
      console.log(`🚀 Servidor rodando na porta ${PORT}`);
      console.log(`📁 Diretório de downloads: ${DOWNLOADS_DIR}`);
      console.log(`⚡ Máximo de downloads simultâneos: ${MAX_CONCURRENT_DOWNLOADS}`);
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