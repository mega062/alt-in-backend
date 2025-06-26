FROM node:18

# Instalar dependências do sistema
RUN apt-get update && apt-get install -y \
    ffmpeg \
    pulseaudio \
    xvfb \
    x11vnc \
    fluxbox \
    wget \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# Instalar Chrome
RUN wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
    && rm -rf /var/lib/apt/lists/*

# Configurar variáveis de ambiente para Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Configurar PulseAudio
RUN echo "load-module module-null-sink sink_name=virtual-speakers" >> /etc/pulse/default.pa

# Criar pasta de trabalho
WORKDIR /app

# Copiar package.json
COPY package*.json ./

# Instalar dependências
RUN npm install

# Copiar código
COPY . .

# Criar script de inicialização
RUN echo '#!/bin/bash\n\
# Iniciar X virtual display\n\
Xvfb :99 -screen 0 1280x720x16 &\n\
export DISPLAY=:99\n\
\n\
# Iniciar PulseAudio\n\
pulseaudio --start --exit-idle-time=-1 &\n\
\n\
# Aguardar um pouco\n\
sleep 2\n\
\n\
# Iniciar aplicação\n\
node server.js' > /app/start.sh && chmod +x /app/start.sh

EXPOSE 3000

CMD ["/app/start.sh"]