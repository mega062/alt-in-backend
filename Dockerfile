# Dockerfile ultra leve - sem Chrome, com fallback
FROM node:18-alpine

# Instalar apenas dependências mínimas
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont

WORKDIR /app

# Instalar apenas dependências básicas
RUN npm install express@4.18.2 puppeteer@24.10.2

# Copiar apenas o server
COPY server.js ./

# Criar diretório
RUN mkdir -p downloads

# Variáveis
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV NODE_ENV=production
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

EXPOSE 10000

CMD ["node", "server.js"]