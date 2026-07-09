FROM oven/bun:1.3.13-debian

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    jq \
    openssh-client \
    tmux \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install

COPY web/package.json web/bun.lock ./web/
RUN cd web && bun install

COPY . .

RUN set -eux; \
  cd web; \
  bun run build; \
  cd /app; \
  mkdir -p /data/repos /data/lfg; \
  rm -rf /app/data; \
  ln -s /data/lfg /app/data

ENV NODE_ENV=production
ENV LFG_INSTALL_CHANNEL=container
ENV LFG_HOST=0.0.0.0
ENV LFG_PORT=8766
ENV LFG_REPOS_ROOT=/data/repos
EXPOSE 8766

CMD ["sh", "-lc", "LFG_PORT=${PORT:-$LFG_PORT} exec bun run serve"]
