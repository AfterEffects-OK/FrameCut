FROM node:22-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public

ENV HOST=0.0.0.0
ENV PORT=4173
EXPOSE 4173

CMD ["node", "server.js"]
