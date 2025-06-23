FROM node:18

# Instala FFmpeg
RUN apt-get update && apt-get install -y ffmpeg

# Cria pasta de trabalho
WORKDIR /app

# Copia os arquivos
COPY . .

# Instala dependências
RUN npm install

# Expõe a porta
EXPOSE 3000

# Comando de start
CMD ["node", "server.js"]
