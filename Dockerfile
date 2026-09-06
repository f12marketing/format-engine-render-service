# Chrome and ffmpeg both have to exist in the image, which is the entire reason
# this service is separate from Convex. Nixpacks can usually infer a Node app,
# but not that it needs a browser -- so the image is explicit.
FROM node:22-bookworm-slim

# chromium pulls its own font and lib dependencies; fonts-liberation and
# fonts-noto-color-emoji matter because captions render through the browser and
# a missing glyph silently becomes a box.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ffmpeg \
      fonts-liberation \
      fonts-noto-color-emoji \
      ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV CHROME_BIN=/usr/bin/chromium
ENV FFMPEG_BIN=/usr/bin/ffmpeg
ENV NODE_ENV=production

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Railway injects PORT; the server already honours it.
EXPOSE 4000
CMD ["node", "server.mjs"]
