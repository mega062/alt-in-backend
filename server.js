const express = require('express');
const puppeteer = require('puppeteer');
const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs').promises;

const app = express();
const PORT = process.env.PORT || 3000;
const execAsync = promisify(exec);

// ======================================================
// CONFIGURAÇÕES
// ======================================================
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const MAX_CONCURRENT = 3; // Menos concorrência por causa do browser
const CLEANUP_INTERVAL = 10 * 60 * 1000; // 10 minutos

// Estado global
const activeRecordings = new Map();
let recordingId = 0;

// ======================================================
// CORS E MIDDLEWARE
// ======================================================
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

app.use(express.json());

// ======================================================
// FUNÇÕES PRINCIPAIS
// ======================================================

// Extrair ID do vídeo
function extractVideoId(url) {
  const regex = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#]+)/;
  const match = url.match(regex);
  return match ? match[1] : null;
}

// Validar URL
function validateYouTubeUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const regex = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|embed\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
  return regex.test(url);
}

// Gerar nome único
function generateUniqueFilename(extension = 'wav') {
  const timestamp = Date.now();
  const random = crypto.randomBytes(4).toString('hex');
  return `beat_${timestamp}_${random}.${extension}`;
}

// Criar diretório se não existir
async function ensureDownloadsDir() {
  try {
    await fs.access(DOWNLOADS_DIR);
  } catch {
    await fs.mkdir(DOWNLOADS_DIR, { recursive: true });
  }
}

// ======================================================
// CORE: GRAVAÇÃO COM BROWSER + FFMPEG
// ======================================================

async function recordBeatCompleto(youtubeUrl, recordingInfo) {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-web-security',
      '--allow-running-insecure-content',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-features=VizDisplayCompositor'
    ]
  });

  let page;
  let ffmpegProcess;
  const outputFile = path.join(DOWNLOADS_DIR, generateUniqueFilename());

  try {
    recordingInfo.status = 'opening_browser';
    recordingInfo.message = 'Abrindo browser...';

    page = await browser.newPage();
    
    // Configurar página para áudio
    await page.setViewport({ width: 1280, height: 720 });
    
    // Bloquear anúncios e outros elementos desnecessários
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      if (resourceType === 'image' || resourceType === 'stylesheet' || resourceType === 'font') {
        req.abort();
      } else if (req.url().includes('googlesyndication') || req.url().includes('googletagservices')) {
        req.abort();
      } else {
        req.continue();
      }
    });

    recordingInfo.status = 'loading_video';
    recordingInfo.message = 'Carregando vídeo...';

    // Navegar para o YouTube
    await page.goto(youtubeUrl, { 
      waitUntil: 'networkidle0',
      timeout: 60000 
    });

    // Aguardar player carregar
    await page.waitForSelector('video', { timeout: 30000 });

    recordingInfo.status = 'preparing_recording';
    recordingInfo.message = 'Preparando gravação...';

    // Obter informações do vídeo
    const videoInfo = await page.evaluate(() => {
      const video = document.querySelector('video');
      const title = document.querySelector('h1.title yt-formatted-string, #title h1, [id="title"] h1')?.innerText || 'Unknown';
      const author = document.querySelector('#channel-name a, #owner-text .yt-simple-endpoint')?.innerText || 'Unknown';
      
      return {
        title: title.trim(),
        author: author.trim(),
        duration: video ? video.duration || 0 : 0,
        currentTime: video ? video.currentTime : 0
      };
    });

    recordingInfo.videoTitle = videoInfo.title;
    recordingInfo.videoAuthor = videoInfo.author;
    recordingInfo.videoDuration = videoInfo.duration;

    console.log(`🎵 Iniciando gravação: ${videoInfo.title} (${Math.round(videoInfo.duration)}s)`);

    // Preparar FFmpeg para captura de áudio via PulseAudio/ALSA
    const ffmpegCommand = `ffmpeg -f pulse -i default -f wav -acodec pcm_s16le -ar 44100 -ac 2 -t ${Math.ceil(videoInfo.duration) + 5} "${outputFile}"`;
    
    recordingInfo.status = 'recording';
    recordingInfo.message = `Gravando beat completo... (${Math.round(videoInfo.duration)}s)`;
    recordingInfo.progress = 0;

    // Iniciar gravação FFmpeg em background
    ffmpegProcess = exec(ffmpegCommand);
    
    // Aguardar um pouco para FFmpeg inicializar
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Iniciar reprodução do vídeo
    await page.evaluate(() => {
      const video = document.querySelector('video');
      if (video) {
        video.currentTime = 0;
        video.play();
      }
    });

    // Monitorar progresso da gravação
    const startTime = Date.now();
    const totalDuration = (videoInfo.duration + 5) * 1000; // +5s de buffer

    const progressInterval = setInterval(async () => {
      try {
        const elapsed = Date.now() - startTime;
        const progress = Math.min((elapsed / totalDuration) * 100, 100);
        
        recordingInfo.progress = Math.round(progress);
        recordingInfo.message = `Gravando... ${Math.round(progress)}%`;

        // Verificar se o vídeo ainda está tocando
        const isPlaying = await page.evaluate(() => {
          const video = document.querySelector('video');
          return video && !video.paused;
        });

        if (!isPlaying && progress < 90) {
          // Tentar retomar reprodução se pausou
          await page.evaluate(() => {
            const video = document.querySelector('video');
            if (video && video.paused) {
              video.play();
            }
          });
        }

      } catch (error) {
        console.log('Erro no monitoramento:', error.message);
      }
    }, 2000);

    // Aguardar conclusão da gravação
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout na gravação'));
      }, totalDuration + 10000);

      ffmpegProcess.on('close', (code) => {
        clearTimeout(timeout);
        clearInterval(progressInterval);
        
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`FFmpeg falhou com código ${code}`));
        }
      });

      ffmpegProcess.on('error', (error) => {
        clearTimeout(timeout);
        clearInterval(progressInterval);
        reject(error);
      });
    });

    recordingInfo.status = 'processing';
    recordingInfo.message = 'Processando áudio...';
    recordingInfo.progress = 95;

    // Verificar se arquivo foi criado
    const stats = await fs.stat(outputFile);
    if (stats.size === 0) {
      throw new Error('Arquivo de gravação está vazio');
    }

    recordingInfo.status = 'completed';
    recordingInfo.message = 'Beat gravado com sucesso!';
    recordingInfo.progress = 100;
    recordingInfo.outputFile = outputFile;
    recordingInfo.fileSize = Math.round(stats.size / 1024); // KB

    console.log(`✅ Gravação concluída: ${path.basename(outputFile)} (${recordingInfo.fileSize}KB)`);

    return outputFile;

  } catch (error) {
    recordingInfo.status = 'error';
    recordingInfo.message = `Erro na gravação: ${error.message}`;
    recordingInfo.error = error.message;
    
    console.error('❌ Erro na gravação:', error);
    throw error;

  } finally {
    // Cleanup
    if (ffmpegProcess) {
      try {
        ffmpegProcess.kill();
      } catch (e) {}
    }
    
    if (page) {
      try {
        await page.close();
      } catch (e) {}
    }
    
    if (browser) {
      try {
        await browser.close();
      } catch (e) {}
    }
  }
}

// ======================================================
// FALLBACK: Gravação usando captura de tela + áudio
// ======================================================

async function recordWithScreenCapture(youtubeUrl, recordingInfo) {
  const outputFile = path.join(DOWNLOADS_DIR, generateUniqueFilename());
  
  try {
    recordingInfo.status = 'screen_capture';
    recordingInfo.message = 'Iniciando captura de tela + áudio...';

    // Usar ffmpeg para captura de tela virtual + áudio
    const ffmpegCommand = `ffmpeg -f x11grab -video_size 1280x720 -framerate 1 -i :99 -f pulse -i default -map 1:a -f wav -acodec pcm_s16le -ar 44100 -ac 2 -t 300 "${outputFile}"`;
    
    recordingInfo.message = 'Gravando via captura de tela...';
    
    await execAsync(ffmpegCommand, { timeout: 320000 }); // 5+ minutos
    
    const stats = await fs.stat(outputFile);
    if (stats.size > 0) {
      recordingInfo.status = 'completed';
      recordingInfo.outputFile = outputFile;
      recordingInfo.fileSize = Math.round(stats.size / 1024);
      return outputFile;
    }
    
    throw new Error('Captura de tela não gerou arquivo');
    
  } catch (error) {
    console.error('❌ Erro na captura de tela:', error);
    throw error;
  }
}

// ======================================================
// ENDPOINTS
// ======================================================

// Endpoint principal: iniciar gravação
app.post('/record-beat', async (req, res) => {
  const { youtubeUrl } = req.body;
  
  console.log('🎤 Nova requisição de gravação:', youtubeUrl);
  
  if (!validateYouTubeUrl(youtubeUrl)) {
    return res.status(400).json({
      error: 'URL inválida',
      message: 'Forneça uma URL válida do YouTube'
    });
  }

  if (activeRecordings.size >= MAX_CONCURRENT) {
    return res.status(503).json({
      error: 'Servidor ocupado',
      message: `Máximo de ${MAX_CONCURRENT} gravações simultâneas. Tente novamente em alguns minutos.`
    });
  }

  const recordingId = `rec_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  
  const recordingInfo = {
    id: recordingId,
    youtubeUrl,
    videoId: extractVideoId(youtubeUrl),
    status: 'queued',
    message: 'Iniciando gravação...',
    progress: 0,
    startedAt: new Date(),
    videoTitle: null,
    videoAuthor: null,
    videoDuration: 0,
    outputFile: null,
    fileSize: 0,
    error: null
  };

  activeRecordings.set(recordingId, recordingInfo);

  // Processar em background
  (async () => {
    try {
      await recordBeatCompleto(youtubeUrl, recordingInfo);
    } catch (error) {
      // Se falhar, tentar método de fallback
      try {
        console.log('🔄 Tentando método de fallback...');
        await recordWithScreenCapture(youtubeUrl, recordingInfo);
      } catch (fallbackError) {
        recordingInfo.status = 'error';
        recordingInfo.error = `Ambos métodos falharam: ${error.message} | ${fallbackError.message}`;
      }
    }
  })();

  res.json({
    success: true,
    recordingId,
    message: 'Gravação iniciada',
    status: recordingInfo.status,
    checkStatusUrl: `/status/${recordingId}`,
    videoId: recordingInfo.videoId
  });
});

// Endpoint: verificar status
app.get('/status/:recordingId', (req, res) => {
  const { recordingId } = req.params;
  const recording = activeRecordings.get(recordingId);
  
  if (!recording) {
    return res.status(404).json({
      error: 'Gravação não encontrada',
      message: 'ID inválido ou gravação expirada'
    });
  }
  
  res.json({
    id: recording.id,
    status: recording.status,
    message: recording.message,
    progress: recording.progress,
    videoTitle: recording.videoTitle,
    videoAuthor: recording.videoAuthor,
    videoDuration: recording.videoDuration,
    fileSize: recording.fileSize,
    downloadUrl: recording.status === 'completed' ? `/download/${recordingId}` : null,
    error: recording.error,
    startedAt: recording.startedAt
  });
});

// Endpoint: download do arquivo
app.get('/download/:recordingId', async (req, res) => {
  const { recordingId } = req.params;
  const recording = activeRecordings.get(recordingId);
  
  if (!recording || recording.status !== 'completed') {
    return res.status(404).json({
      error: 'Arquivo não disponível',
      message: 'Gravação não concluída ou não encontrada'
    });
  }
  
  try {
    const filePath = recording.outputFile;
    await fs.access(filePath);
    
    const filename = `${recording.videoTitle || 'beat'}_complete.wav`
      .replace(/[^\w\s-]/g, '')
      .trim()
      .substring(0, 100);
    
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'audio/wav');
    
    res.sendFile(path.resolve(filePath), (err) => {
      if (err) {
        console.error('Erro no download:', err);
      } else {
        console.log(`📥 Download concluído: ${recordingId}`);
        
        // Agendar limpeza do arquivo
        setTimeout(async () => {
          try {
            await fs.unlink(filePath);
            activeRecordings.delete(recordingId);
            console.log(`🧹 Arquivo limpo: ${recordingId}`);
          } catch (cleanupError) {
            console.error('Erro na limpeza:', cleanupError);
          }
        }, 5 * 60 * 1000); // 5 minutos após download
      }
    });
    
  } catch (error) {
    res.status(500).json({
      error: 'Erro no arquivo',
      message: error.message
    });
  }
});

// Endpoint: página de teste
app.get('/test', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>🎵 Beat Inteiro - Gravação Completa</title>
        <meta charset="UTF-8">
        <style>
            body { font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; background: #1a1a1a; color: white; }
            .container { background: #2d2d2d; padding: 30px; border-radius: 15px; }
            h1 { color: #ff6b6b; text-align: center; }
            input { width: 100%; padding: 15px; margin: 10px 0; border: none; border-radius: 5px; }
            button { width: 100%; padding: 15px; background: #ff6b6b; color: white; border: none; border-radius: 5px; cursor: pointer; font-size: 16px; }
            button:hover { background: #ee5a52; }
            .status { margin: 20px 0; padding: 15px; background: #333; border-radius: 5px; }
            .progress { width: 100%; height: 20px; background: #444; border-radius: 10px; overflow: hidden; margin: 10px 0; }
            .progress-bar { height: 100%; background: linear-gradient(90deg, #ff6b6b, #4ecdc4); transition: width 0.3s; }
            .download { background: #4ecdc4; }
            .error { background: #ff4757; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🎵 Beat Inteiro</h1>
            <p>Gravação completa de beats do YouTube com máxima qualidade</p>
            
            <input type="text" id="youtubeUrl" placeholder="Cole o link do YouTube aqui..." 
                   value="https://www.youtube.com/watch?v=ysFIwSGdR48">
            <button onclick="startRecording()">🎤 Gravar Beat Completo</button>
            
            <div id="result"></div>
        </div>

        <script>
            let checkInterval;
            
            async function startRecording() {
                const url = document.getElementById('youtubeUrl').value;
                if (!url) return alert('Cole um link do YouTube!');
                
                try {
                    const response = await fetch('/record-beat', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ youtubeUrl: url })
                    });
                    
                    const data = await response.json();
                    
                    if (response.ok) {
                        showStatus('🎤 Gravação iniciada!', 0, 'recording');
                        checkStatus(data.recordingId);
                    } else {
                        showError(data.message);
                    }
                } catch (error) {
                    showError('Erro de conexão: ' + error.message);
                }
            }
            
            async function checkStatus(recordingId) {
                if (checkInterval) clearInterval(checkInterval);
                
                checkInterval = setInterval(async () => {
                    try {
                        const response = await fetch(\`/status/\${recordingId}\`);
                        const data = await response.json();
                        
                        if (response.ok) {
                            if (data.status === 'completed') {
                                clearInterval(checkInterval);
                                showDownload(data);
                            } else if (data.status === 'error') {
                                clearInterval(checkInterval);
                                showError(data.error);
                            } else {
                                showStatus(data.message, data.progress, data.status, data);
                            }
                        }
                    } catch (error) {
                        console.error('Erro ao verificar status:', error);
                    }
                }, 2000);
            }
            
            function showStatus(message, progress, status, data) {
                const info = data ? \`
                    <p><strong>Vídeo:</strong> \${data.videoTitle || 'Carregando...'}</p>
                    <p><strong>Autor:</strong> \${data.videoAuthor || 'Carregando...'}</p>
                    <p><strong>Duração:</strong> \${data.videoDuration ? Math.round(data.videoDuration) + 's' : 'Carregando...'}</p>
                \` : '';
                
                document.getElementById('result').innerHTML = \`
                    <div class="status">
                        <h3>\${message}</h3>
                        \${info}
                        <div class="progress">
                            <div class="progress-bar" style="width: \${progress}%"></div>
                        </div>
                        <p>\${progress}% concluído</p>
                    </div>
                \`;
            }
            
            function showDownload(data) {
                document.getElementById('result').innerHTML = \`
                    <div class="status download">
                        <h3>✅ Beat Gravado com Sucesso!</h3>
                        <p><strong>Vídeo:</strong> \${data.videoTitle}</p>
                        <p><strong>Autor:</strong> \${data.videoAuthor}</p>
                        <p><strong>Duração:</strong> \${Math.round(data.videoDuration)}s</p>
                        <p><strong>Tamanho:</strong> \${data.fileSize}KB</p>
                        <br>
                        <a href="\${data.downloadUrl}" download>
                            <button>📥 Baixar Beat Completo (WAV)</button>
                        </a>
                    </div>
                \`;
            }
            
            function showError(message) {
                document.getElementById('result').innerHTML = \`
                    <div class="status error">
                        <h3>❌ Erro na Gravação</h3>
                        <p>\${message}</p>
                    </div>
                \`;
            }
        </script>
    </body>
    </html>
  `);
});

// Endpoint: status do servidor
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    activeRecordings: activeRecordings.size,
    maxConcurrent: MAX_CONCURRENT,
    method: 'beat_inteiro_recording',
    features: [
      'Gravação completa do beat',
      'Puppeteer + FFmpeg',
      'Qualidade máxima (WAV 44.1kHz)',
      'Fallback com captura de tela',
      'Monitoramento em tempo real'
    ]
  });
});

// ======================================================
// LIMPEZA E INICIALIZAÇÃO
// ======================================================

// Limpeza periódica
async function cleanup() {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 minutos
  
  for (const [id, recording] of activeRecordings) {
    const age = now - new Date(recording.startedAt).getTime();
    
    if (age > maxAge) {
      if (recording.outputFile) {
        try {
          await fs.unlink(recording.outputFile);
        } catch (e) {}
      }
      activeRecordings.delete(id);
      console.log(`🧹 Gravação expirada removida: ${id}`);
    }
  }
}

// Inicializar servidor
async function startServer() {
  await ensureDownloadsDir();
  
  setInterval(cleanup, CLEANUP_INTERVAL);
  
  app.listen(PORT, () => {
    console.log(`🚀 Servidor Beat Inteiro rodando na porta ${PORT}`);
    console.log(`🎤 Método: Gravação completa com Puppeteer + FFmpeg`);
    console.log(`⚡ Máximo de gravações simultâneas: ${MAX_CONCURRENT}`);
    console.log(`🌐 Teste em: http://localhost:${PORT}/test`);
    console.log(`💡 Funcionalidade: Grava o beat COMPLETO em alta qualidade!`);
  });
}

startServer();