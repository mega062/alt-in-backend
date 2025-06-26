# Dockerfile mínimo e funcional
FROM node:18

# Instalar Chrome
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates

RUN wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google.list

RUN apt-get update && apt-get install -y \
    google-chrome-stable \
    libxss1 \
    libasound2 \
    libgtk-3-0 \
    libnss3 \
    libgbm1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Instalar dependências com versões corretas
RUN npm install express@4.18.2 puppeteer@24.10.2 puppeteer-stream@3.0.20

# Copiar apenas o server.js
COPY server.js ./

# Criar diretório de downloads
RUN mkdir -p downloads

# Variáveis de ambiente
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome
ENV NODE_ENV=production
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

EXPOSE 10000

CMD ["node", "server.js"]