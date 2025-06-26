const express = require('express');
const puppeteer = require('puppeteer');
const { promisify } = require('util');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs').promises;

const app = express();
const PORT = process.env.PORT || 3000;

// ======================================================
// CONFIGURAÇÕES
// ======================================================
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const MAX_CONCURRENT = 3;
const CLEANUP_INTERVAL = 10 * 60 * 1000;

// Estado global
const activeRecordings = new Map();

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

function extractVideoId(url) {
  const regex = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#]+)/;
  const match = url.match(regex);
  return match ? match[1] : null;
}

function validateYouTubeUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const regex = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|embed\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
  return regex.test(url);
}

function generateUniqueFilename(extension = 'webm') {
  const timestamp = Date.now();
  const random = crypto.randomBytes(4).toString('hex');
  return `beat_${timestamp}_${random}.${extension}`;
}

async function ensureDownloadsDir() {
  try {
    await fs.access(DOWNLOADS_DIR);
  } catch {
    await fs.mkdir(DOWNLOADS_DIR, { recursive: true });
  }
}

// ======================================================
// CORE: PUPPETEER PURO - GRAVAÇÃO DIRETA
// ======================================================

async function recordAudioDirect(youtubeUrl, recordingInfo) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-web-security',
      '--allow-running-insecure-content',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-features=VizDisplayCompositor',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-infobars',
      '--disable-translate',
      '--disable-extensions',
      '--no-first-run',
      '--no-default-browser-check',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--allow-file-access-from-files'
    ]
  });

  let page;
  const outputFile = path.join(DOWNLOADS_DIR, generateUniqueFilename());

  try {
    recordingInfo.status = 'opening_browser';
    recordingInfo.message = 'Abrindo browser...';

    page = await browser.newPage();
    
    await page.setViewport({ width: 1280, height: 720 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // ✅ Interceptação mínima - só anúncios pesados
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = req.url();
      
      // Bloquear só anúncios pesados
      if (url.includes('googlesyndication') || url.includes('doubleclick') || url.includes('googletagservices')) {
        req.abort();
      } else {
        req.continue();
      }
    });

    recordingInfo.status = 'loading_video';
    recordingInfo.message = 'Carregando YouTube...';

    const cleanUrl = youtubeUrl.split('&list=')[0].split('&start_radio=')[0];
    console.log(`🎵 Abrindo: ${cleanUrl}`);

    await page.goto(cleanUrl, { 
      waitUntil: 'networkidle2',
      timeout: 90000 
    });

    // ✅ Aguardar página carregar
    console.log('⏳ Aguardando player carregar...');
    await new Promise(resolve => setTimeout(resolve, 8000));

    recordingInfo.status = 'preparing_recording';
    recordingInfo.message = 'Preparando gravação...';

    // ✅ Pegar informações básicas
    const pageInfo = await page.evaluate(() => {
      let title = document.title.replace(' - YouTube', '').trim();
      
      const ogTitle = document.querySelector('meta[property="og:title"]');
      if (ogTitle && ogTitle.content) {
        title = ogTitle.content;
      }
      
      let author = 'Unknown';
      const authorMeta = document.querySelector('meta[name="author"]');
      if (authorMeta && authorMeta.content) {
        author = authorMeta.content;
      }
      
      return {
        title: title || 'Unknown Beat',
        author: author,
        url: window.location.href
      };
    });

    recordingInfo.videoTitle = pageInfo.title;
    recordingInfo.videoAuthor = pageInfo.author;

    console.log(`🎵 Detectado: ${pageInfo.title} por ${pageInfo.author}`);

    recordingInfo.status = 'recording';
    recordingInfo.message = 'Iniciando gravação direta...';
    recordingInfo.progress = 10;

    // ✅ GRAVAÇÃO DIRETA COM PUPPETEER - USANDO MEDIA RECORDER API
    const audioData = await page.evaluate(async () => {
      return new Promise(async (resolve, reject) => {
        try {
          console.log('🎤 Iniciando captura de áudio...');

          // ✅ Capturar áudio da aba atual
          const stream = await navigator.mediaDevices.getDisplayMedia({
            audio: {
              echoCancellation: false,
              noiseSuppression: false,
              sampleRate: 44100
            },
            video: false
          });

          // ✅ Configurar MediaRecorder
          const recorder = new MediaRecorder(stream, {
            mimeType: 'audio/webm;codecs=opus',
            audioBitsPerSecond: 128000
          });

          const chunks = [];
          let recordingStarted = false;

          recorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
              chunks.push(event.data);
              console.log(`📊 Chunk gravado: ${event.data.size} bytes`);
            }
          };

          recorder.onstop = () => {
            console.log('🛑 Gravação finalizada');
            const blob = new Blob(chunks, { type: 'audio/webm' });
            
            // Converter blob para ArrayBuffer
            const reader = new FileReader();
            reader.onload = () => {
              const arrayBuffer = reader.result;
              const uint8Array = new Uint8Array(arrayBuffer);
              resolve(Array.from(uint8Array));
            };
            reader.readAsArrayBuffer(blob);
          };

          recorder.onerror = (error) => {
            console.error('❌ Erro na gravação:', error);
            reject(error);
          };

          // ✅ Iniciar gravação
          recorder.start(1000); // Chunk a cada 1 segundo
          recordingStarted = true;
          console.log('🔴 Gravação iniciada!');

          // ✅ Tentar tocar o vídeo
          const videos = document.querySelectorAll('video');
          videos.forEach(video => {
            if (video) {
              video.muted = false;
              video.volume = 1.0;
              video.currentTime = 0;
              video.play().then(() => {
                console.log('▶️ Vídeo tocando');
              }).catch(e => {
                console.log('⚠️ Erro ao tocar vídeo:', e);
              });
            }
          });

          // ✅ Tentar clicar em botões de play
          const playButtons = document.querySelectorAll(
            '.ytp-play-button, [aria-label*="play"], [aria-label*="Play"], button[title*="play"]'
          );
          playButtons.forEach(btn => {
            try {
              btn.click();
              console.log('🖱️ Clicou em botão de play');
            } catch (e) {}
          });

          // ✅ Simular tecla espaço
          document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));

          // ✅ Determinar quando parar a gravação
          let duration = 0;
          let silenceCount = 0;
          
          const checkInterval = setInterval(() => {
            duration += 2;
            
            // Verificar se vídeo está tocando
            const playingVideos = Array.from(document.querySelectorAll('video')).filter(v => !v.paused && !v.ended);
            
            if (playingVideos.length === 0) {
              silenceCount++;
              console.log(`🔇 Sem vídeos tocando (${silenceCount}/5)`);
              
              if (silenceCount >= 5) { // 10 segundos sem áudio
                console.log('🛑 Parando gravação - sem áudio detectado');
                clearInterval(checkInterval);
                recorder.stop();
                stream.getTracks().forEach(track => track.stop());
              }
            } else {
              silenceCount = 0;
            }

            // Timeout máximo de 10 minutos
            if (duration > 600) {
              console.log('⏰ Timeout - parando gravação');
              clearInterval(checkInterval);
              recorder.stop();
              stream.getTracks().forEach(track => track.stop());
            }
          }, 2000);

        } catch (error) {
          console.error('❌ Erro na captura:', error);
          reject(error);
        }
      });
    });

    recordingInfo.progress = 80;
    recordingInfo.message = 'Processando áudio gravado...';

    console.log(`📊 Dados de áudio recebidos: ${audioData.length} bytes`);

    // ✅ Salvar arquivo
    const buffer = Buffer.from(audioData);
    await fs.writeFile(outputFile, buffer);

    const stats = await fs.stat(outputFile);
    
    if (stats.size === 0) {
      throw new Error('Arquivo de gravação está vazio');
    }

    recordingInfo.status = 'completed';
    recordingInfo.message = 'Beat gravado com sucesso!';
    recordingInfo.progress = 100;
    recordingInfo.outputFile = outputFile;
    recordingInfo.fileSize = Math.round(stats.size / 1024);
    recordingInfo.videoDuration = Math.round(stats.size / 16000); // Estimativa baseada no tamanho

    console.log(`✅ Gravação concluída: ${path.basename(outputFile)} (${recordingInfo.fileSize}KB)`);

    return outputFile;

  } catch (error) {
    recordingInfo.status = 'error';
    recordingInfo.message = `Erro na gravação: ${error.message}`;
    recordingInfo.error = error.message;
    
    console.error('❌ Erro na gravação:', error);
    throw error;

  } finally {
    if (page) {
      try {
        await page.close();
      } catch (e) {
        console.log('Erro ao fechar página:', e.message);
      }
    }
    
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.log('Erro ao fechar browser:', e.message);
      }
    }
  }
}

// ======================================================
// ENDPOINTS
// ======================================================

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

  // ✅ Processar com Puppeteer puro
  (async () => {
    try {
      await recordAudioDirect(youtubeUrl, recordingInfo);
    } catch (error) {
      recordingInfo.status = 'error';
      recordingInfo.error = `Gravação falhou: ${error.message}`;
      console.error('❌ Erro na gravação:', error);
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
    
    const filename = `${recording.videoTitle || 'beat'}_complete.webm`
      .replace(/[^\w\s-]/g, '')
      .trim()
      .substring(0, 100);
    
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'audio/webm');
    
    res.sendFile(path.resolve(filePath), (err) => {
      if (err) {
        console.error('Erro no download:', err);
      } else {
        console.log(`📥 Download concluído: ${recordingId}`);
        
        setTimeout(async () => {
          try {
            await fs.unlink(filePath);
            activeRecordings.delete(recordingId);
            console.log(`🧹 Arquivo limpo: ${recordingId}`);
          } catch (cleanupError) {
            console.error('Erro na limpeza:', cleanupError);
          }
        }, 5 * 60 * 1000);
      }
    });
    
  } catch (error) {
    res.status(500).json({
      error: 'Erro no arquivo',
      message: error.message
    });
  }
});

app.get('/test', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
    <title>🎵 Beat Inteiro - Puppeteer PURO</title>
    <meta charset="UTF-8">
    <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; background: #1a1a1a; color: white; }
        .container { background: #2d2d2d; padding: 30px; border-radius: 15px; }
        h1 { color: #ff6b6b; text-align: center; }
        .subtitle { text-align: center; margin-bottom: 30px; color: #4ecdc4; }
        input { width: 100%; padding: 15px; margin: 10px 0; border: none; border-radius: 5px; }
        button { width: 100%; padding: 15px; background: #ff6b6b; color: white; border: none; border-radius: 5px; cursor: pointer; font-size: 16px; }
        button:hover { background: #ee5a52; }
        .status { margin: 20px 0; padding: 15px; background: #333; border-radius: 5px; }
        .progress { width: 100%; height: 20px; background: #444; border-radius: 10px; overflow: hidden; margin: 10px 0; }
        .progress-bar { height: 100%; background: linear-gradient(90deg, #ff6b6b, #4ecdc4); transition: width 0.3s; }
        .download { background: #4ecdc4; }
        .error { background: #ff4757; }
        .feature { background: #2a2a2a; padding: 15px; margin: 10px 0; border-radius: 5px; border-left: 3px solid #ff6b6b; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎵 Beat Inteiro</h1>
        <div class="subtitle">🔥 PUPPETEER PURO - Foda-se FFmpeg!</div>
        
        <div class="feature">
            <strong>🎤 Gravação direta:</strong> Usa MediaRecorder API do browser para capturar áudio em tempo real, sem depender de FFmpeg ou seletores!
        </div>
        
        <input type="text" id="youtubeUrl" placeholder="Cole o link do YouTube aqui..." 
               value="https://www.youtube.com/watch?v=ysFIwSGdR48">
        <button onclick="startRecording()">🎤 Gravar Beat (Puppeteer Puro)</button>
        
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
                    const response = await fetch('/status/' + recordingId);
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
            const info = data ? 
                '<p><strong>Vídeo:</strong> ' + (data.videoTitle || 'Detectando...') + '</p>' +
                '<p><strong>Autor:</strong> ' + (data.videoAuthor || 'Detectando...') + '</p>' +
                '<p><strong>Tamanho:</strong> ' + (data.fileSize ? data.fileSize + 'KB' : 'Gravando...') + '</p>'
                : '';
            
            document.getElementById('result').innerHTML = 
                '<div class="status">' +
                    '<h3>' + message + '</h3>' +
                    info +
                    '<div class="progress">' +
                        '<div class="progress-bar" style="width: ' + progress + '%"></div>' +
                    '</div>' +
                    '<p>' + progress + '% concluído</p>' +
                '</div>';
        }
        
        function showDownload(data) {
            document.getElementById('result').innerHTML = 
                '<div class="status download">' +
                    '<h3>✅ Beat Gravado com Sucesso!</h3>' +
                    '<p><strong>Vídeo:</strong> ' + data.videoTitle + '</p>' +
                    '<p><strong>Autor:</strong> ' + data.videoAuthor + '</p>' +
                    '<p><strong>Tamanho:</strong> ' + data.fileSize + 'KB</p>' +
                    '<p><strong>Formato:</strong> WebM (áudio puro)</p>' +
                    '<br>' +
                    '<a href="' + data.downloadUrl + '" download>' +
                        '<button>📥 Baixar Beat Completo (WebM)</button>' +
                    '</a>' +
                '</div>';
        }
        
        function showError(message) {
            document.getElementById('result').innerHTML = 
                '<div class="status error">' +
                    '<h3>❌ Erro na Gravação</h3>' +
                    '<p>' + message + '</p>' +
                '</div>';
        }
    </script>
</body>
</html>`);
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    activeRecordings: activeRecordings.size,
    maxConcurrent: MAX_CONCURRENT,
    method: 'puppeteer_pure_mediarecorder',
    features: [
      'Gravação direta com MediaRecorder API',
      'Puppeteer puro - sem FFmpeg',
      'Captura de áudio em tempo real',
      'Detecção automática do fim do áudio',
      'Formato WebM nativo'
    ]
  });
});

// ======================================================
// LIMPEZA E INICIALIZAÇÃO
// ======================================================

async function cleanup() {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000;
  
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

async function startServer() {
  await ensureDownloadsDir();
  
  setInterval(cleanup, CLEANUP_INTERVAL);
  
  app.listen(PORT, () => {
    console.log(`🚀 Servidor Beat Inteiro rodando na porta ${PORT}`);
    console.log(`🎤 Método: PUPPETEER PURO (foda-se FFmpeg!)`);
    console.log(`⚡ Máximo de gravações simultâneas: ${MAX_CONCURRENT}`);
    console.log(`🌐 Teste em: http://localhost:${PORT}/test`);
    console.log(`💡 Funcionalidade: MediaRecorder API direto no browser!`);
  });
}

startServer();