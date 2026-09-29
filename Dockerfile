FROM node:22-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install root runtime dependencies and SDK build dependencies before copying
# the source tree to keep Docker layer caching effective.
COPY package.json ./
COPY anime-sdk/package*.json ./anime-sdk/
RUN npm install --omit=dev --no-audit --no-fund \
  && cd anime-sdk \
  && npm install --include=dev --no-audit --no-fund

COPY . .

RUN cd anime-sdk && npm run build
RUN pip3 install --no-cache-dir --break-system-packages -r kuhi/requirements.txt

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "gateway/server.mjs"]
