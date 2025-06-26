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

function generateUniqueFilename(extension = 'wav') {
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
// CORE: GRAVAÇÃO COM BROWSER + FFMPEG (VERSÃO MELHORADA)
// ======================================================

async function recordBeatCompleto(youtubeUrl, recordingInfo) {
  const browser = await puppeteer.launch({
    headless: "new",
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
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check'
    ]
  });

  let page;
  let ffmpegProcess;
  const outputFile = path.join(DOWNLOADS_DIR, generateUniqueFilename());

  try {
    recordingInfo.status = 'opening_browser';
    recordingInfo.message = 'Abrindo browser...';

    page = await browser.newPage();
    
    await page.setViewport({ width: 1280, height: 720 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // ✅ Interceptação mais seletiva - permite scripts do YouTube
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      const url = req.url();
      
      // Permitir scripts do YouTube (necessários para o player)
      if (url.includes('youtube.com') && resourceType === 'script') {
        req.continue();
      } else if (resourceType === 'image' || resourceType === 'stylesheet' || resourceType === 'font') {
        req.abort();
      } else if (url.includes('googlesyndication') || url.includes('googletagservices')) {
        req.abort();
      } else {
        req.continue();
      }
    });

    recordingInfo.status = 'loading_video';
    recordingInfo.message = 'Carregando vídeo...';

    const cleanUrl = youtubeUrl.split('&list=')[0].split('&start_radio=')[0];
    console.log(`🎵 URL limpa: ${cleanUrl}`);

    await page.goto(cleanUrl, { 
      waitUntil: 'networkidle2', // ✅ Aguarda mais carregamento
      timeout: 90000 // ✅ Timeout maior
    });

    // ✅ Aguardar mais tempo para página carregar
    console.log('⏳ Aguardando página carregar completamente...');
    await new Promise(resolve => setTimeout(resolve, 10000)); // 10s

    // ✅ DEBUG: Verificar o que tem na página
    console.log('🔍 Debugando elementos da página...');
    const pageDebug = await page.evaluate(() => {
      const videos = document.querySelectorAll('video');
      const players = document.querySelectorAll('[id*="player"], [class*="player"]');
      const containers = document.querySelectorAll('[id*="movie"], [class*="movie"]');
      
      return {
        videosCount: videos.length,
        videosInfo: Array.from(videos).map(v => ({
          id: v.id,
          className: v.className,
          tagName: v.tagName,
          src: v.src,
          currentSrc: v.currentSrc
        })),
        playersCount: players.length,
        playersInfo: Array.from(players).slice(0, 5).map(p => ({
          id: p.id,
          className: p.className,
          tagName: p.tagName
        })),
        containersCount: containers.length,
        containersInfo: Array.from(containers).slice(0, 5).map(c => ({
          id: c.id,
          className: c.className,
          tagName: c.tagName
        })),
        url: window.location.href,
        title: document.title
      };
    });
    
    console.log('📊 Debug da página:', JSON.stringify(pageDebug, null, 2));

    // ✅ Lista expandida de seletores
    const videoSelectors = [
      'video',
      '#movie_player video',
      '.html5-video-player video',
      'video.video-stream',
      '[data-layer="4"] video',
      '#player video',
      '.ytp-html5-video',
      'video.html5-main-video',
      '[id*="video"] video',
      '[class*="video"] video',
      'ytd-player video',
      '#ytd-player video',
      '.ytd-player video',
      'div[id="movie_player"] video',
      'div[class*="player"] video'
    ];

    let videoElement = null;
    let foundSelector = null;
    
    for (const selector of videoSelectors) {
      try {
        console.log(`🔍 Tentando seletor: ${selector}`);
        await page.waitForSelector(selector, { timeout: 8000 });
        
        // ✅ Verificar se o elemento realmente existe e é válido
        const isValid = await page.evaluate((sel) => {
          const element = document.querySelector(sel);
          return element && element.tagName === 'VIDEO';
        }, selector);
        
        if (isValid) {
          videoElement = selector;
          foundSelector = selector;
          console.log(`✅ Vídeo encontrado com: ${selector}`);
          break;
        } else {
          console.log(`⚠️ Seletor ${selector} encontrou elemento, mas não é um vídeo válido`);
        }
        
      } catch (e) {
        console.log(`❌ Seletor ${selector} falhou: ${e.message}`);
        continue;
      }
    }

    // ✅ Se não encontrou com seletores, tentar aguardar mais e forçar carregamento
    if (!videoElement) {
      console.log('🔄 Nenhum seletor funcionou, tentando estratégias alternativas...');
      
      // Tentar clicar em botões de play ou consent
      try {
        const buttons = await page.evaluate(() => {
          const playButtons = document.querySelectorAll('button[aria-label*="play"], button[title*="play"], .ytp-play-button, [role="button"]');
          const consentButtons = document.querySelectorAll('button[aria-label*="Accept"], button[aria-label*="Aceitar"], button:contains("I agree")');
          
          return {
            playButtons: playButtons.length,
            consentButtons: consentButtons.length
          };
        });
        
        console.log(`🔍 Encontrados ${buttons.playButtons} botões de play e ${buttons.consentButtons} botões de consent`);
        
        // Tentar aceitar cookies/consent
        try {
          await page.click('button[aria-label*="Accept"], button[aria-label*="Aceitar"]', { timeout: 3000 });
          console.log('✅ Clicou em botão de consent');
          await new Promise(resolve => setTimeout(resolve, 3000));
        } catch (e) {
          console.log('⚠️ Sem botões de consent encontrados');
        }
        
        // Tentar aguardar mais um pouco
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Tentar os seletores novamente
        for (const selector of videoSelectors.slice(0, 5)) { // Apenas os principais
          try {
            console.log(`🔄 Re-tentando seletor: ${selector}`);
            await page.waitForSelector(selector, { timeout: 5000 });
            videoElement = selector;
            foundSelector = selector;
            console.log(`✅ Vídeo encontrado na segunda tentativa com: ${selector}`);
            break;
          } catch (e) {
            continue;
          }
        }
        
      } catch (error) {
        console.log('⚠️ Erro ao tentar estratégias alternativas:', error.message);
      }
    }

    if (!videoElement) {
      // ✅ Salvar screenshot para debug
      try {
        const screenshot = await page.screenshot({ encoding: 'base64' });
        console.log('📸 Screenshot da página salvo (primeiros 100 chars):', screenshot.substring(0, 100));
      } catch (e) {
        console.log('⚠️ Não foi possível capturar screenshot');
      }
      
      throw new Error(`Player de vídeo não encontrado. Página carregada: ${pageDebug.title}. Vídeos encontrados: ${pageDebug.videosCount}`);
    }

    recordingInfo.status = 'preparing_recording';
    recordingInfo.message = 'Preparando gravação...';

    // ✅ Obter informações do vídeo com fallbacks (melhorado)
    const videoInfo = await page.evaluate((videoSelector) => {
      const video = document.querySelector(videoSelector);
      
      // Título - mais seletores
      const titleSelectors = [
        'h1.title yt-formatted-string',
        '#title h1',
        '[id="title"] h1',
        '.ytd-video-primary-info-renderer h1',
        'h1.ytd-watch-metadata',
        'h1[class*="title"]',
        '.watch-title',
        '#watch-headline-title',
        'meta[property="og:title"]'
      ];
      
      let title = 'Unknown';
      for (const titleSel of titleSelectors) {
        try {
          let titleEl;
          if (titleSel.startsWith('meta')) {
            titleEl = document.querySelector(titleSel);
            if (titleEl && titleEl.content) {
              title = titleEl.content.trim();
              break;
            }
          } else {
            titleEl = document.querySelector(titleSel);
            if (titleEl && titleEl.innerText && titleEl.innerText.trim()) {
              title = titleEl.innerText.trim();
              break;
            }
          }
        } catch (e) {
          continue;
        }
      }

      // Autor - mais seletores
      const authorSelectors = [
        '#channel-name a',
        '#owner-text .yt-simple-endpoint',
        '.ytd-channel-name a',
        '#upload-info #channel-name a',
        '[class*="channel"] a',
        'meta[name="author"]'
      ];
      
      let author = 'Unknown';
      for (const authorSel of authorSelectors) {
        try {
          let authorEl;
          if (authorSel.startsWith('meta')) {
            authorEl = document.querySelector(authorSel);
            if (authorEl && authorEl.content) {
              author = authorEl.content.trim();
              break;
            }
          } else {
            authorEl = document.querySelector(authorSel);
            if (authorEl && authorEl.innerText && authorEl.innerText.trim()) {
              author = authorEl.innerText.trim();
              break;
            }
          }
        } catch (e) {
          continue;
        }
      }
      
      // Duração com fallbacks
      let duration = 300; // Default
      if (video) {
        if (video.duration && video.duration > 0) {
          duration = video.duration;
        } else {
          // Tentar obter de elementos da página
          const durationElements = document.querySelectorAll('.ytp-time-duration, [class*="duration"], [aria-label*="duration"]');
          for (const el of durationElements) {
            const text = el.innerText || el.textContent || el.getAttribute('aria-label') || '';
            const match = text.match(/(\d+):(\d+)/);
            if (match) {
              duration = parseInt(match[1]) * 60 + parseInt(match[2]);
              break;
            }
          }
        }
      }
      
      return {
        title: title,
        author: author,
        duration: duration,
        currentTime: video ? video.currentTime : 0,
        videoFound: !!video,
        videoSrc: video ? video.src : 'none',
        videoCurrentSrc: video ? video.currentSrc : 'none'
      };
    }, videoElement);

    recordingInfo.videoTitle = videoInfo.title;
    recordingInfo.videoAuthor = videoInfo.author;
    recordingInfo.videoDuration = videoInfo.duration;

    console.log(`🎵 Informações obtidas: ${videoInfo.title} por ${videoInfo.author} (${Math.round(videoInfo.duration)}s)`);
    console.log(`🎵 Vídeo encontrado: ${videoInfo.videoFound}, Src: ${videoInfo.videoSrc}`);

    const recordingDuration = Math.ceil(videoInfo.duration) + 10;
    
    const audioCommands = [
      `ffmpeg -f pulse -i default -f wav -acodec pcm_s16le -ar 44100 -ac 2 -t ${recordingDuration} "${outputFile}"`,
      `ffmpeg -f alsa -i default -f wav -acodec pcm_s16le -ar 44100 -ac 2 -t ${recordingDuration} "${outputFile}"`,
      `ffmpeg -f alsa -i hw:0 -f wav -acodec pcm_s16le -ar 44100 -ac 2 -t ${recordingDuration} "${outputFile}"`
    ];
    
    recordingInfo.status = 'recording';
    recordingInfo.message = `Gravando beat completo... (${Math.round(videoInfo.duration)}s)`;
    recordingInfo.progress = 0;

    let ffmpegStarted = false;
    for (let i = 0; i < audioCommands.length; i++) {
      try {
        console.log(`🎤 Tentativa FFmpeg ${i + 1}: ${audioCommands[i].split(' ').slice(0, 6).join(' ')}...`);
        
        ffmpegProcess = exec(audioCommands[i]);
        
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        if (!ffmpegProcess.killed) {
          ffmpegStarted = true;
          console.log(`✅ FFmpeg iniciado com comando ${i + 1}`);
          break;
        }
      } catch (error) {
        console.log(`❌ Comando FFmpeg ${i + 1} falhou: ${error.message}`);
        continue;
      }
    }

    if (!ffmpegStarted) {
      throw new Error('Nenhum comando FFmpeg funcionou');
    }

    // ✅ Iniciar reprodução com mais tentativas
    console.log(`🎬 Iniciando reprodução com seletor: ${foundSelector}`);
    await page.evaluate((videoSelector) => {
      const video = document.querySelector(videoSelector);
      if (video) {
        console.log('🎬 Configurando vídeo...');
        video.currentTime = 0;
        video.muted = false;
        video.volume = 1.0;
        
        // Múltiplas tentativas de play
        const tryPlay = () => {
          const playPromise = video.play();
          if (playPromise !== undefined) {
            playPromise
              .then(() => console.log('✅ Play bem-sucedido'))
              .catch(error => {
                console.log('⚠️ Erro no play, tentando novamente:', error);
                setTimeout(tryPlay, 1000);
              });
          }
        };
        
        tryPlay();
        
        // Também tentar clicar em botões de play
        const playButtons = document.querySelectorAll('.ytp-play-button, [aria-label*="play"], [title*="play"]');
        playButtons.forEach(btn => {
          try {
            btn.click();
          } catch (e) {}
        });
      }
    }, videoElement);

    console.log(`🔴 Gravação iniciada para ${Math.round(videoInfo.duration)}s`);

    const startTime = Date.now();
    const totalDuration = (videoInfo.duration + 10) * 1000;

    const progressInterval = setInterval(async () => {
      try {
        const elapsed = Date.now() - startTime;
        const progress = Math.min((elapsed / totalDuration) * 100, 100);
        
        recordingInfo.progress = Math.round(progress);
        recordingInfo.message = `Gravando... ${Math.round(progress)}% (${Math.round(elapsed/1000)}s)`;

        const videoStatus = await page.evaluate((videoSelector) => {
          const video = document.querySelector(videoSelector);
          return {
            paused: video ? video.paused : true,
            currentTime: video ? video.currentTime : 0,
            ended: video ? video.ended : false
          };
        }, videoElement);

        if (videoStatus.paused && !videoStatus.ended && progress < 90) {
          console.log('⚠️ Vídeo pausado, tentando retomar...');
          await page.evaluate((videoSelector) => {
            const video = document.querySelector(videoSelector);
            if (video && video.paused) {
              video.play().catch(e => console.log('Erro ao retomar:', e));
            }
          }, videoElement);
        }

      } catch (error) {
        console.log('Erro no monitoramento:', error.message);
      }
    }, 2000);

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout na gravação'));
      }, totalDuration + 30000);

      ffmpegProcess.on('close', (code) => {
        clearTimeout(timeout);
        clearInterval(progressInterval);
        
        console.log(`🏁 FFmpeg terminou com código: ${code}`);
        
        if (code === 0 || code === null) {
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

    const stats = await fs.stat(outputFile);
    if (stats.size === 0) {
      throw new Error('Arquivo de gravação está vazio');
    }

    recordingInfo.status = 'completed';
    recordingInfo.message = 'Beat gravado com sucesso!';
    recordingInfo.progress = 100;
    recordingInfo.outputFile = outputFile;
    recordingInfo.fileSize = Math.round(stats.size / 1024);

    console.log(`✅ Gravação concluída: ${path.basename(outputFile)} (${recordingInfo.fileSize}KB)`);

    return outputFile;

  } catch (error) {
    recordingInfo.status = 'error';
    recordingInfo.message = `Erro na gravação: ${error.message}`;
    recordingInfo.error = error.message;
    
    console.error('❌ Erro na gravação:', error);
    throw error;

  } finally {
    if (ffmpegProcess && !ffmpegProcess.killed) {
      try {
        ffmpegProcess.kill('SIGTERM');
        setTimeout(() => {
          if (!ffmpegProcess.killed) {
            ffmpegProcess.kill('SIGKILL');
          }
        }, 5000);
      } catch (e) {
        console.log('Erro ao finalizar FFmpeg:', e.message);
      }
    }
    
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

async function recordWithScreenCapture(youtubeUrl, recordingInfo) {
  const outputFile = path.join(DOWNLOADS_DIR, generateUniqueFilename());
  
  try {
    recordingInfo.status = 'screen_capture';
    recordingInfo.message = 'Iniciando captura de tela + áudio...';

    const ffmpegCommand = `ffmpeg -f x11grab -video_size 1280x720 -framerate 1 -i :99 -f pulse -i default -map 1:a -f wav -acodec pcm_s16le -ar 44100 -ac 2 -t 300 "${outputFile}"`;
    
    recordingInfo.message = 'Gravando via captura de tela...';
    
    await execAsync(ffmpegCommand, { timeout: 320000 });
    
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

  (async () => {
    try {
      await recordBeatCompleto(youtubeUrl, recordingInfo);
    } catch (error) {
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
                '<p><strong>Vídeo:</strong> ' + (data.videoTitle || 'Carregando...') + '</p>' +
                '<p><strong>Autor:</strong> ' + (data.videoAuthor || 'Carregando...') + '</p>' +
                '<p><strong>Duração:</strong> ' + (data.videoDuration ? Math.round(data.videoDuration) + 's' : 'Carregando...') + '</p>'
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
                    '<p><strong>Duração:</strong> ' + Math.round(data.videoDuration) + 's</p>' +
                    '<p><strong>Tamanho:</strong> ' + data.fileSize + 'KB</p>' +
                    '<br>' +
                    '<a href="' + data.downloadUrl + '" download>' +
                        '<button>📥 Baixar Beat Completo (WAV)</button>' +
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
    console.log(`🎤 Método: Gravação completa com Puppeteer + FFmpeg`);
    console.log(`⚡ Máximo de gravações simultâneas: ${MAX_CONCURRENT}`);
    console.log(`🌐 Teste em: http://localhost:${PORT}/test`);
    console.log(`💡 Funcionalidade: Grava o beat COMPLETO em alta qualidade!`);
  });
}

startServer();
    </style>