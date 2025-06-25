// Melhorias para o seu server.js

// 1. Adicionar no início do arquivo (depois dos imports)
process.env.YTDL_NO_UPDATE = 'true'; // Desabilitar verificação de updates

// 2. Substituir a função getVideoInfo por esta versão melhorada:
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
    console.log(`Primeira tentativa falhou: ${error.message}`);
    
    try {
      // Segunda tentativa - com cookies e headers diferentes
      const info = await ytdl.getInfo(cleanUrl, {
        requestOptions: {
          headers: {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Cookie': 'CONSENT=YES+cb.20210328-17-p0.en+FX+667;',
            'Accept-Language': 'en-US,en;q=0.9',
          }
        }
      });
      
      return {
        title: info.videoDetails.title,
        duration: parseInt(info.videoDetails.lengthSeconds),
        author: info.videoDetails.author.name
      };
    } catch (error2) {
      console.log(`Segunda tentativa falhou: ${error2.message}`);
      
      try {
        // Terceira tentativa - básica
        const basicInfo = await ytdl.getBasicInfo(cleanUrl);
        return {
          title: basicInfo.videoDetails.title || 'Video',
          duration: parseInt(basicInfo.videoDetails.lengthSeconds) || 0,
          author: basicInfo.videoDetails.author?.name || 'Unknown'
        };
      } catch (error3) {
        console.log(`Terceira tentativa falhou: ${error3.message}`);
        
        // Fallback - usar informações mínimas extraídas da URL
        const videoId = extractVideoId(cleanUrl);
        return {
          title: `YouTube Video ${videoId}`,
          duration: 300, // 5 minutos como estimativa
          author: 'Unknown'
        };
      }
    }
  }
}

// 3. Substituir a função downloadAndConvert por esta versão:
async function downloadAndConvert(youtubeUrl, outputDir) {
  const tempAudioFile = path.join(outputDir, generateUniqueFilename('mp4'));
  const outputFile = path.join(outputDir, generateUniqueFilename('wav'));
  
  // Limpar URL
  const cleanUrl = youtubeUrl.split('&list=')[0].split('&start_radio=')[0];
  
  return new Promise((resolve, reject) => {
    try {
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
              
              console.log(`Conversão concluída: ${(convertedStats.size / 1024 / 1024).toFixed(2)} MB`);
              
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