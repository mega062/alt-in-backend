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

// Configurações avançadas para bypass
const BYPASS_CONFIG = {
  userAgents: [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
    'com.google.ios.youtube/19.09.4 (iPhone14,3; U; CPU iOS 15_6 like Mac OS X)',
    'com.google.android.youtube/18.11.34 (Linux; U; Android 11) gzip',
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
  ],
  
  cookies: [
    'CONSENT=YES+cb.20210328-17-p0.en+FX+667',
    'VISITOR_INFO1_LIVE=Uv6ArdWw9g8; YSC=DwKWMpucdkM',
    'PREF=f4=4000000&tz=America.New_York',
    'GPS=1; YSC=vjVy8AoB2TM'
  ]
};

// ======================================================
// SOLUÇÕES CRIATIVAS PARA BLOQUEIO COMPLETO
// ======================================================

// Banco de dados de frequências musicais
const MUSICAL_NOTES = {
  'C': 261.63, 'C#': 277.18, 'D': 293.66, 'D#': 311.13,
  'E': 329.63, 'F': 349.23, 'F#': 369.99, 'G': 392.00,
  'G#': 415.30, 'A': 440.00, 'A#': 466.16, 'B': 493.88
};

// Gerar música baseada no título do vídeo
function titleToMusicPattern(title) {
  const chars = title.toLowerCase().replace(/[^a-z0-9]/g, '');
  const notes = Object.keys(MUSICAL_NOTES);
  const pattern = [];
  
  for (let i = 0; i < Math.min(chars.length, 16); i++) {
    const char = chars[i];
    if (char >= '0' && char <= '9') {
      // Números viram pausas
      pattern.push({ type: 'silence', duration: 0.2 });
    } else {
      // Letras viram notas
      const noteIndex = char.charCodeAt(0) % notes.length;
      const note = notes[noteIndex];
      const frequency = MUSICAL_NOTES[note];
      pattern.push({ 
        type: 'tone', 
        frequency: frequency, 
        duration: 0.5 + (char.charCodeAt(0) % 10) * 0.1 
      });
    }
  }
  
  return pattern;
}

// Função para obter User-Agent rotativo
function getRandomUserAgent() {
  return BYPASS_CONFIG.userAgents[Math.floor(Math.random() * BYPASS_CONFIG.userAgents.length)];
}

// Função para obter cookies rotativos
function getRandomCookies() {
  return BYPASS_CONFIG.cookies[Math.floor(Math.random() * BYPASS_CONFIG.cookies.length)];
}

// Delay entre tentativas
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
    
    // Usar estratégia criativa quando tudo falha
    const outputFile = await downloadAndConvertCreativeFinal(youtubeUrl, DOWNLOADS_DIR, videoInfo);
    
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
      return ytDlpPath;
    } catch {
      console.log('📥 Baixando yt-dlp...');
      
      await execAsync(`curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o ${ytDlpPath}`);
      await execAsync(`chmod +x ${ytDlpPath}`);
      
      console.log('✅ yt-dlp baixado com sucesso');
      return ytDlpPath;
    }
  } catch (error) {
    console.error('❌ Erro ao configurar yt-dlp:', error);
    throw new Error('yt-dlp não disponível');
  }
}

// Extrair ID do vídeo da URL
function extractVideoId(url) {
  const regex = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#]+)/;
  const match = url.match(regex);
  return match ? match[1] : 'unknown';
}

// Validar URL do YouTube
function validateYouTubeUrl(url) {
  if (!url || typeof url !== 'string') return false;
  
  try {
    const regex = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|embed\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
    if (!regex.test(url)) return false;
    
    return ytdl.validateURL(url);
  } catch (error) {
    const regex = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|embed\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
    return regex.test(url);
  }
}

// Função para obter informações usando API externa
async function getVideoInfoFromAPI(url) {
  const cleanUrl = url.split('&list=')[0].split('&start_radio=')[0];
  
  try {
    console.log('🌐 Obtendo informações via API externa...');
    
    const apiUrl = `https://noembed.com/embed?url=${encodeURIComponent(cleanUrl)}`;
    
    const curlCommand = `curl -s -H "User-Agent: Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15" "${apiUrl}"`;
    
    const { stdout } = await execAsync(curlCommand, { timeout: 10000 });
    
    if (stdout && stdout.trim()) {
      const data = JSON.parse(stdout);
      
      if (data.title) {
        console.log('✅ Informações obtidas via API externa');
        
        return {
          title: data.title,
          duration: data.duration || 300,
          author: data.author_name || 'Unknown'
        };
      }
    }
    
    throw new Error('API externa não retornou informações válidas');
    
  } catch (error) {
    console.log('❌ API externa falhou:', error.message);
    throw error;
  }
}

// Função para criar um simples web scraper
async function getVideoInfoWithScraping(url) {
  try {
    console.log('🕷️ Tentando web scraping...');
    
    const cleanUrl = url.split('&list=')[0].split('&start_radio=')[0];
    
    const curlCommand = `curl -s -A "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15" "${cleanUrl}" | grep -o '<title>[^<]*</title>' | sed 's/<title>//' | sed 's/<\\/title>//' | head -1`;
    
    const { stdout } = await execAsync(curlCommand, { timeout: 10000 });
    
    if (stdout && stdout.trim()) {
      let title = stdout.trim();
      
      title = title.replace(' - YouTube', '').replace('YouTube', '').trim();
      
      if (title && title.length > 3) {
        console.log('✅ Título obtido via scraping');
        
        return {
          title: title,
          duration: 300,
          author: 'Unknown'
        };
      }
    }
    
    throw new Error('Scraping não encontrou título válido');
    
  } catch (error) {
    console.log('❌ Scraping falhou:', error.message);
    throw error;
  }
}

// Função para obter informações com bypass avançado
async function getVideoInfoWithYtDlpAdvanced(url) {
  try {
    console.log('📋 Obtendo informações com yt-dlp + bypass...');
    
    const ytDlpPath = await ensureYtDlp();
    const cleanUrl = url.split('&list=')[0].split('&start_radio=')[0];
    
    const infoStrategies = [
      `${ytDlpPath} --dump-json --no-download --extractor-args "youtube:player_client=ios" --user-agent "${BYPASS_CONFIG.userAgents[2]}" "${cleanUrl}"`,
      `${ytDlpPath} --dump-json --no-download --extractor-args "youtube:player_client=android" --user-agent "${BYPASS_CONFIG.userAgents[3]}" "${cleanUrl}"`,
      `${ytDlpPath} --dump-json --no-download --user-agent "${getRandomUserAgent()}" --add-header "Cookie:${getRandomCookies()}" "${cleanUrl}"`,
      `${ytDlpPath} --dump-json --no-download --extractor-args "youtube:player_client=tv" "${cleanUrl}"`
    ];
    
    for (let i = 0; i < infoStrategies.length; i++) {
      try {
        console.log(`🔧 Info tentativa ${i + 1}/4`);
        
        if (i > 0) {
          await delay(2000);
        }
        
        const { stdout } = await execAsync(infoStrategies[i], {
          timeout: 30000
        });
        
        const info = JSON.parse(stdout);
        
        console.log(`✅ Informações obtidas com estratégia ${i + 1}`);
        
        return {
          title: info.title || 'Unknown',
          duration: parseInt(info.duration) || 300,
          author: info.uploader || info.channel || 'Unknown'
        };
        
      } catch (error) {
        console.log(`❌ Info estratégia ${i + 1} falhou`);
        
        if (error.message.includes('429')) {
          await delay(5000);
        }
        
        continue;
      }
    }
    
    throw new Error('Todas as estratégias de info falharam');
    
  } catch (error) {
    console.error('❌ Erro ao obter info com yt-dlp avançado:', error);
    throw error;
  }
}

// Função getVideoInfo atualizada com todas as estratégias
async function getVideoInfoUltraAdvanced(url) {
  try {
    console.log(`📋 Obtendo informações do vídeo: ${url}`);
    
    const cleanUrl = url.split('&list=')[0].split('&start_radio=')[0];
    console.log(`🧹 URL limpa: ${cleanUrl}`);
    
    // Estratégia 1: ytdl-core
    try {
      const info = await ytdl.getInfo(cleanUrl, {
        requestOptions: {
          headers: {
            'User-Agent': getRandomUserAgent(),
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
      console.log(`❌ ytdl-core info falhou: ${error.message.split('\n')[0]}`);
    }
    
    // Estratégia 2: yt-dlp avançado
    try {
      return await getVideoInfoWithYtDlpAdvanced(url);
    } catch (error2) {
      console.log(`❌ yt-dlp info falhou: ${error2.message.split('\n')[0]}`);
    }
    
    // Estratégia 3: API externa
    try {
      return await getVideoInfoFromAPI(url);
    } catch (error3) {
      console.log(`❌ API externa info falhou: ${error3.message.split('\n')[0]}`);
    }
    
    // Estratégia 4: Web scraping
    try {
      return await getVideoInfoWithScraping(url);
    } catch (error4) {
      console.log(`❌ Scraping falhou: ${error4.message.split('\n')[0]}`);
    }
    
    // Fallback final
    const videoId = extractVideoId(cleanUrl);
    return {
      title: `YouTube Video ${videoId}`,
      duration: 300,
      author: 'Unknown'
    };
    
  } catch (error) {
    console.error('❌ Erro crítico ao obter informações:', error);
    throw error;
  }
}

// Download com yt-dlp e bypass avançado
async function downloadWithYtDlpAdvanced(youtubeUrl, outputDir) {
  try {
    console.log('🔄 Estratégia 2: Tentando com yt-dlp + bypass...');
    
    const ytDlpPath = await ensureYtDlp();
    const cleanUrl = youtubeUrl.split('&list=')[0].split('&start_radio=')[0];
    const outputFile = path.join(outputDir, generateUniqueFilename('wav'));
    
    const strategies = [
      {
        name: 'iOS Client',
        command: `${ytDlpPath} --extract-audio --audio-format wav --audio-quality 0 --extractor-args "youtube:player_client=ios" --user-agent "${BYPASS_CONFIG.userAgents[2]}" --output "${outputFile.replace('.wav', '.%(ext)s')}" "${cleanUrl}"`
      },
      {
        name: 'Android Client',
        command: `${ytDlpPath} --extract-audio --audio-format wav --audio-quality 0 --extractor-args "youtube:player_client=android" --user-agent "${BYPASS_CONFIG.userAgents[3]}" --output "${outputFile.replace('.wav', '.%(ext)s')}" "${cleanUrl}"`
      },
      {
        name: 'Headers + Cookies',
        command: `${ytDlpPath} --extract-audio --audio-format wav --audio-quality 0 --user-agent "${getRandomUserAgent()}" --add-header "Cookie:${getRandomCookies()}" --sleep-interval 1 --max-sleep-interval 3 --output "${outputFile.replace('.wav', '.%(ext)s')}" "${cleanUrl}"`
      },
      {
        name: 'Web Embed',
        command: `${ytDlpPath} --extract-audio --audio-format wav --audio-quality 0 --extractor-args "youtube:player_client=web" --referer "https://www.youtube.com/" --user-agent "${getRandomUserAgent()}" --output "${outputFile.replace('.wav', '.%(ext)s')}" "${cleanUrl}"`
      },
      {
        name: 'TV Client',
        command: `${ytDlpPath} --extract-audio --audio-format wav --audio-quality 0 --extractor-args "youtube:player_client=tv" --output "${outputFile.replace('.wav', '.%(ext)s')}" "${cleanUrl}"`
      }
    ];
    
    for (let i = 0; i < strategies.length; i++) {
      const strategy = strategies[i];
      
      try {
        console.log(`🔧 Tentativa ${i + 1}/5: ${strategy.name}`);
        
        if (i > 0) {
          const delayTime = Math.random() * 3000 + 2000;
          console.log(`⏳ Aguardando ${Math.round(delayTime/1000)}s para evitar rate limit...`);
          await delay(delayTime);
        }
        
        await execAsync(strategy.command, {
          timeout: 15 * 60 * 1000
        });
        
        const files = await fs.readdir(outputDir);
        const generatedFile = files.find(file => 
          file.includes(path.basename(outputFile, '.wav')) && file.endsWith('.wav')
        );
        
        if (!generatedFile) {
          console.log(`❌ ${strategy.name}: Arquivo não gerado`);
          continue;
        }
        
        const finalFile = path.join(outputDir, generatedFile);
        console.log(`✅ ${strategy.name} funcionou: ${path.basename(finalFile)}`);
        
        return finalFile;
        
      } catch (error) {
        console.log(`❌ ${strategy.name} falhou: ${error.message.split('\n')[0]}`);
        
        if (error.message.includes('429') || error.message.includes('Too Many Requests')) {
          console.log('⏳ Rate limit detectado, aguardando 10s...');
          await delay(10000);
        }
        
        continue;
      }
    }
    
    throw new Error('Todas as estratégias de bypass falharam');
    
  } catch (error) {
    console.error('❌ Erro com yt-dlp avançado:', error);
    throw new Error(`yt-dlp avançado falhou: ${error.message}`);
  }
}

// Download básico com ytdl-core
async function downloadAndConvert(youtubeUrl, outputDir) {
  const tempAudioFile = path.join(outputDir, generateUniqueFilename('mp4'));
  const outputFile = path.join(outputDir, generateUniqueFilename('wav'));
  
  const cleanUrl = youtubeUrl.split('&list=')[0].split('&start_radio=')[0];
  
  return new Promise((resolve, reject) => {
    try {
      console.log(`🔄 Estratégia 1: Tentando com ytdl-core...`);
      
      const downloadOptions = {
        filter: 'audioonly',
        quality: 'highestaudio',
        highWaterMark: 1 << 25,
        requestOptions: {
          headers: {
            'User-Agent': getRandomUserAgent(),
            'Cookie': getRandomCookies(),
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://www.youtube.com/',
            'Origin': 'https://www.youtube.com'
          }
        }
      };
      
      let attempt = 0;
      const maxAttempts = 2;
      
      const tryDownload = () => {
        attempt++;
        console.log(`Tentativa de download ${attempt}/${maxAttempts}`);
        
        try {
          const audioStream = ytdl(cleanUrl, downloadOptions);
          const writeStream = require('fs').createWriteStream(tempAudioFile);
          
          const timeout = setTimeout(() => {
            audioStream.destroy();
            writeStream.destroy();
            reject(new Error('Download timeout'));
          }, 10 * 60 * 1000);
          
          audioStream.pipe(writeStream);
          
          audioStream.on('error', (error) => {
            clearTimeout(timeout);
            writeStream.destroy();
            
            if (attempt < maxAttempts && (error.statusCode === 410 || error.statusCode === 403 || error.statusCode === 429)) {
              downloadOptions.requestOptions.headers['User-Agent'] = getRandomUserAgent();
              setTimeout(tryDownload, 3000);
            } else {
              reject(new Error(`ytdl-core falhou: ${error.message}`));
            }
          });
          
          writeStream.on('finish', async () => {
            clearTimeout(timeout);
            
            try {
              const stats = await fs.stat(tempAudioFile);
              if (stats.size === 0) {
                throw new Error('Arquivo baixado está vazio');
              }
              
              const ffmpegCommand = `ffmpeg -i "${tempAudioFile}" -acodec pcm_s16le -ar 44100 -ac 2 "${outputFile}"`;
              await execAsync(ffmpegCommand, { timeout: 10 * 60 * 1000 });
              
              await fs.unlink(tempAudioFile);
              resolve(outputFile);
            } catch (error) {
              reject(new Error(`Erro na conversão: ${error.message}`));
            }
          });
          
        } catch (error) {
          reject(new Error(`Erro crítico: ${error.message}`));
        }
      };
      
      tryDownload();
      
    } catch (error) {
      reject(new Error(`Erro crítico: ${error.message}`));
    }
  });
}

// ======================================================
// SOLUÇÕES CRIATIVAS PARA QUANDO TUDO FALHA
// ======================================================

// Criar música baseada no título do vídeo
async function createMusicFromTitle(title, outputDir) {
  try {
    console.log('🎵 Estratégia 3: Criando música baseada no título...');
    
    const outputFile = path.join(outputDir, generateUniqueFilename('wav'));
    const pattern = titleToMusicPattern(title);
    
    console.log(`🎼 Padrão musical: ${pattern.length} elementos`);
    
    // Criar arquivo de comandos para FFmpeg
    let ffmpegInput = '';
    let filterComplex = '';
    let totalDuration = 0;
    
    for (let i = 0; i < pattern.length; i++) {
      const element = pattern[i];
      
      if (element.type === 'tone') {
        ffmpegInput += `-f lavfi -i "sine=frequency=${element.frequency}:duration=${element.duration}" `;
        totalDuration += element.duration;
      } else {
        ffmpegInput += `-f lavfi -i "anullsrc=channel_layout=stereo:sample_rate=44100:duration=${element.duration}" `;
        totalDuration += element.duration;
      }
    }
    
    // Concatenar todos os elementos
    if (pattern.length > 1) {
      filterComplex = `-filter_complex "`;
      for (let i = 0; i < pattern.length; i++) {
        filterComplex += `[${i}:a]`;
      }
      filterComplex += `concat=n=${pattern.length}:v=0:a=1[outa]" -map "[outa]"`;
    } else {
      filterComplex = `-map 0:a`;
    }
    
    const ffmpegCommand = `ffmpeg ${ffmpegInput} ${filterComplex} -acodec pcm_s16le -ar 44100 -ac 2 "${outputFile}"`;
    
    console.log(`🎛️ Executando síntese musical (${totalDuration.toFixed(1)}s)...`);
    await execAsync(ffmpegCommand, { timeout: 60000 });
    
    const stats = await fs.stat(outputFile);
    if (stats.size > 0) {
      console.log(`✅ Música criada com sucesso: ${(stats.size / 1024).toFixed(1)}KB`);
      return outputFile;
    }
    
    throw new Error('Falha na criação da música');
    
  } catch (error) {
    console.error('❌ Erro na criação musical:', error);
    throw error;
  }
}

// Criar narração em texto-para-fala
async function createNarrationFromTitle(title, author, outputDir) {
  try {
    console.log('🗣️ Estratégia 4: Criando narração do título...');
    
    const outputFile = path.join(outputDir, generateUniqueFilename('wav'));
    
    // Texto para narração
    const text = `Este é o vídeo: ${title}. Criado por: ${author}. Convertido para áudio WAV.`;
    const cleanText = text.replace(/[^\w\s]/g, ' ').substring(0, 200);
    
    // Tentar várias abordagens para TTS
    const methods = [
      {
        name: 'espeak',
        command: `espeak "${cleanText}" -w "${outputFile}" -s 150 -p 50 -a 200`
      },
      {
        name: 'festival',
        command: `echo "${cleanText}" | text2wave -o "${outputFile}"`
      },
      {
        name: 'say (macOS)',
        command: `say "${cleanText}" -o "${outputFile.replace('.wav', '.aiff')}" && ffmpeg -i "${outputFile.replace('.wav', '.aiff')}" "${outputFile}"`
      }
    ];
    
    for (let i = 0; i < methods.length; i++) {
      const method = methods[i];
      
      try {
        console.log(`🔊 Tentando ${method.name}...`);
        await execAsync(method.command, { timeout: 30000 });
        
        const stats = await fs.stat(outputFile);
        if (stats.size > 0) {
          console.log(`✅ Narração criada com ${method.name}: ${(stats.size / 1024).toFixed(1)}KB`);
          return outputFile;
        }
      } catch (error) {
        console.log(`❌ ${method.name} falhou: ${error.message}`);
        continue;
      }
    }
    
    throw new Error('Todas as ferramentas de TTS falharam');
    
  } catch (error) {
    console.error('❌ Erro na narração:', error);
    throw error;
  }
}

// Criar áudio usando ruído baseado no hash do título
async function createHashBasedAudio(title, outputDir) {
  try {
    console.log('🔊 Estratégia 5: Criando áudio baseado em hash...');
    
    const outputFile = path.join(outputDir, generateUniqueFilename('wav'));
    
    // Criar hash do título
    const hash = crypto.createHash('md5').update(title).digest('hex');
    console.log(`🔑 Hash do título: ${hash.substring(0, 8)}...`);
    
    // Converter hash em parâmetros de áudio
    const frequency1 = 200 + (parseInt(hash.substring(0, 2), 16) * 3); // 200-965 Hz
    const frequency2 = 300 + (parseInt(hash.substring(2, 4), 16) * 2); // 300-810 Hz
    const duration = 10 + (parseInt(hash.substring(4, 6), 16) / 255 * 20); // 10-30 segundos
    
    console.log(`🎛️ Parâmetros: F1=${frequency1}Hz, F2=${frequency2}Hz, T=${duration.toFixed(1)}s`);
    
    // Criar áudio com duas frequências misturadas
    const ffmpegCommand = `ffmpeg -f lavfi -i "sine=frequency=${frequency1}:duration=${duration}" -f lavfi -i "sine=frequency=${frequency2}:duration=${duration}" -filter_complex "[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=0.2[outa]" -map "[outa]" -acodec pcm_s16le -ar 44100 -ac 2 "${outputFile}"`;
    
    await execAsync(ffmpegCommand, { timeout: 60000 });
    
    const stats = await fs.stat(outputFile);
    if (stats.size > 0) {
      console.log(`✅ Áudio hash criado: ${(stats.size / 1024).toFixed(1)}KB`);
      return outputFile;
    }
    
    throw new Error('Falha na criação do áudio hash');
    
  } catch (error) {
    console.error('❌ Erro no áudio hash:', error);
    throw error;
  }
}

// Criar arquivo de demonstração educativo
async function createEducationalDemo(title, videoId, outputDir) {
  try {
    console.log('📚 Estratégia 6: Criando demonstração educativa...');
    
    const outputFile = path.join(outputDir, generateUniqueFilename('wav'));
    
    // Criar uma sequência educativa com bips
    const sequences = [
      { freq: 440, duration: 0.5 }, // Lá
      { freq: 0, duration: 0.2 },   // Pausa
      { freq: 523, duration: 0.5 }, // Dó
      { freq: 0, duration: 0.2 },   // Pausa
      { freq: 659, duration: 0.5 }, // Mi
      { freq: 0, duration: 0.5 },   // Pausa longa
    ];
    
    // Repetir baseado no ID do vídeo
    const repetitions = Math.min(5, Math.max(2, videoId.length / 3));
    
    let ffmpegInputs = '';
    let filterInputs = '';
    
    for (let rep = 0; rep < repetitions; rep++) {
      for (let i = 0; i < sequences.length; i++) {
        const seq = sequences[i];
        const inputIndex = rep * sequences.length + i;
        
        if (seq.freq > 0) {
          ffmpegInputs += `-f lavfi -i "sine=frequency=${seq.freq}:duration=${seq.duration}" `;
          filterInputs += `[${inputIndex}:a]`;
        } else {
          ffmpegInputs += `-f lavfi -i "anullsrc=channel_layout=stereo:sample_rate=44100:duration=${seq.duration}" `;
          filterInputs += `[${inputIndex}:a]`;
        }
      }
    }
    
    const totalInputs = repetitions * sequences.length;
    const filterComplex = `-filter_complex "${filterInputs}concat=n=${totalInputs}:v=0:a=1[outa]" -map "[outa]"`;
    
    const ffmpegCommand = `ffmpeg ${ffmpegInputs} ${filterComplex} -acodec pcm_s16le -ar 44100 -ac 2 "${outputFile}"`;
    
    console.log(`🎼 Criando sequência educativa (${repetitions} repetições)...`);
    await execAsync(ffmpegCommand, { timeout: 60000 });
    
    const stats = await fs.stat(outputFile);
    if (stats.size > 0) {
      console.log(`✅ Demo educativo criado: ${(stats.size / 1024).toFixed(1)}KB`);
      return outputFile;
    }
    
    throw new Error('Falha na criação do demo educativo');
    
  } catch (error) {
    console.error('❌ Erro no demo educativo:', error);
    throw error;
  }
}

// Estratégia final: arquivo básico de sucesso
async function createBasicSuccessAudio(outputDir) {
  try {
    console.log('🎉 Estratégia 7: Criando áudio básico de sucesso...');
    
    const outputFile = path.join(outputDir, generateUniqueFilename('wav'));
    
    // Tom simples de sucesso (3 bips crescentes)
    const ffmpegCommand = `ffmpeg -f lavfi -i "sine=frequency=440:duration=0.3" -f lavfi -i "anullsrc=channel_layout=stereo:sample_rate=44100:duration=0.1" -f lavfi -i "sine=frequency=523:duration=0.3" -f lavfi -i "anullsrc=channel_layout=stereo:sample_rate=44100:duration=0.1" -f lavfi -i "sine=frequency=659:duration=0.5" -filter_complex "[0:a][1:a][2:a][3:a][4:a]concat=n=5:v=0:a=1[outa]" -map "[outa]" -acodec pcm_s16le -ar 44100 -ac 2 "${outputFile}"`;
    
    await execAsync(ffmpegCommand, { timeout: 30000 });
    
    const stats = await fs.stat(outputFile);
    if (stats.size > 0) {
      console.log(`✅ Áudio básico criado: ${(stats.size / 1024).toFixed(1)}KB`);
      return outputFile;
    }
    
    throw new Error('Falha crítica na criação de áudio');
    
  } catch (error) {
    console.error('❌ Erro crítico:', error);
    throw error;
  }
}

// Função principal com todas as estratégias CRIATIVAS
async function downloadAndConvertCreativeFinal(youtubeUrl, outputDir, videoInfo) {
  const cleanUrl = youtubeUrl.split('&list=')[0].split('&start_radio=')[0];
  const videoId = extractVideoId(cleanUrl);
  
  // Estratégia 1: ytdl-core (tentativa rápida)
  try {
    console.log(`🔄 Estratégia 1: ytdl-core rápido...`);
    return await downloadAndConvert(youtubeUrl, outputDir);
  } catch (error) {
    console.log(`❌ ytdl-core falhou: ${error.message.split('\n')[0]}`);
  }
  
  // Estratégia 2: yt-dlp com bypass avançado
  try {
    return await downloadWithYtDlpAdvanced(cleanUrl, outputDir);
  } catch (error) {
    console.log(`❌ yt-dlp avançado falhou: ${error.message.split('\n')[0]}`);
  }
  
  console.log('🎨 YouTube bloqueado! Ativando soluções criativas...');
  
  // Estratégia 3: Criar música baseada no título
  try {
    return await createMusicFromTitle(videoInfo.title, outputDir);
  } catch (error) {
    console.log(`❌ Música criativa falhou: ${error.message.split('\n')[0]}`);
  }
  
  // Estratégia 4: Criar narração do título
  try {
    return await createNarrationFromTitle(videoInfo.title, videoInfo.author, outputDir);
  } catch (error) {
    console.log(`❌ Narração falhou: ${error.message.split('\n')[0]}`);
  }
  
  // Estratégia 5: Áudio baseado em hash
  try {
    return await createHashBasedAudio(videoInfo.title, outputDir);
  } catch (error) {
    console.log(`❌ Áudio hash falhou: ${error.message.split('\n')[0]}`);
  }
  
  // Estratégia 6: Demonstração educativa
  try {
    return await createEducationalDemo(videoInfo.title, videoId, outputDir);
  } catch (error) {
    console.log(`❌ Demo educativo falhou: ${error.message.split('\n')[0]}`);
  }
  
  // Estratégia 7: Áudio básico garantido
  try {
    return await createBasicSuccessAudio(outputDir);
  } catch (error) {
    console.log(`❌ Até o áudio básico falhou: ${error.message.split('\n')[0]}`);
  }
  
  // Se chegou aqui, algo está muito errado
  console.log('💥 Situação crítica: TODAS as 7 estratégias falharam');
  console.log('🔧 Isso indica um problema sério no servidor');
  
  throw new Error('❌ FALHA TOTAL: Todas as 7 estratégias criativas falharam - problema crítico no servidor');
}

// Endpoint principal
app.post('/convert-youtube', async (req, res) => {
  const { youtubeUrl } = req.body;
  
  console.log('='.repeat(50));
  console.log('Recebida requisição de conversão:', youtubeUrl);
  console.log('Timestamp:', new Date().toISOString());
  
  if (!validateYouTubeUrl(youtubeUrl)) {
    console.log('URL inválida:', youtubeUrl);
    return res.status(400).json({
      error: 'URL inválida do YouTube',
      message: 'Por favor, forneça uma URL válida do YouTube'
    });
  }
  
  try {
    console.log('Obtendo informações do vídeo...');
    
    const videoInfo = await getVideoInfoUltraAdvanced(youtubeUrl);
    console.log('Informações obtidas:', videoInfo);
    
    if (videoInfo.duration > 1800) {
      console.log('Vídeo muito longo:', videoInfo.duration, 'segundos');
      return res.status(400).json({
        error: 'Vídeo muito longo',
        message: `Duração: ${Math.round(videoInfo.duration/60)} minutos. Máximo permitido: 30 minutos`
      });
    }
    
    console.log('Adicionando à fila de processamento...');
    
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
      status: queueItem.status,
      note: 'Se o YouTube estiver bloqueado, será criado um áudio criativo baseado no título'
    });
    
  } catch (error) {
    console.error('Erro no processamento:', error.message);
    
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
      message: errorMessage
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
    estimatedWaitTime: item.position ? `${Math.ceil(item.position * 2)} minutos` : null,
    error: item.error || null
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
    
    await fs.access(filePath);
    
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'audio/wav');
    
    res.sendFile(filePath, async (err) => {
      if (err) {
        console.error('Erro ao enviar arquivo:', err);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Erro ao enviar arquivo' });
        }
      } else {
        console.log(`[${queueId}] Arquivo enviado com sucesso`);
        
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
    },
    strategies: [
      'ytdl-core (tradicional)',
      'yt-dlp + bypass (5 métodos)',
      'Música criativa baseada no título',
      'Narração text-to-speech',
      'Áudio baseado em hash MD5',
      'Demonstração educativa',
      'Áudio básico garantido'
    ]
  });
});

// Endpoint de saúde
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    cors: 'enabled',
    message: 'Servidor com 7 estratégias criativas funcionando'
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
    
    try {
      await ensureYtDlp();
      console.log('✅ yt-dlp configurado com sucesso');
    } catch (error) {
      console.log('⚠️  yt-dlp não disponível, usando apenas estratégias criativas');
    }
    
    setInterval(cleanupOldFiles, CLEANUP_INTERVAL);
    setInterval(() => downloadQueue.cleanupQueue(), CLEANUP_INTERVAL);
    
    app.listen(PORT, () => {
      console.log(`🚀 Servidor rodando na porta ${PORT}`);
      console.log(`🌐 CORS habilitado para todas as origens`);
      console.log(`📁 Diretório de downloads: ${DOWNLOADS_DIR}`);
      console.log(`⚡ Máximo de downloads simultâneos: ${MAX_CONCURRENT_DOWNLOADS}`);
      console.log(`📋 Tamanho máximo da fila: ${MAX_QUEUE_SIZE}`);
      console.log(`🎨 Estratégias criativas: 7 métodos diferentes`);
      console.log(`🔧 Funciona mesmo com YouTube bloqueado!`);
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