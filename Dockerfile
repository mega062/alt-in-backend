# Dockerfile com yt-dlp para download real de áudio
FROM node:18-slim

# Instalar dependências do sistema
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Instalar yt-dlp (sucessor do youtube-dl)
RUN pip3 install --no-cache-dir yt-dlp

# Criar usuário não-root
RUN groupadd -r appuser && useradd -r -g appuser appuser \
    && mkdir -p /home/appuser \
    && chown -R appuser:appuser /home/appuser

WORKDIR /app

# Copiar package.json e instalar dependências do Node.js
COPY package.json ./
RUN npm install --production && npm cache clean --force

# Copiar código
COPY server.js ./

# Criar diretório e ajustar permissões
RUN mkdir -p downloads && chown -R appuser:appuser /app

# Mudar para usuário não-root
USER appuser

# Variáveis de ambiente
ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:10000/health || exit 1

EXPOSE 10000

# Comando de start
CMD ["node", "server.js"]