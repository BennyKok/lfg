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

ARG LFG_REPO_SLUG=BennyKok/lfg
ARG LFG_RELEASE=latest
ARG LFG_RELEASE_ASSET=lfg-bundle.tar.gz

RUN set -eux; \
  if [ "$LFG_RELEASE" = "latest" ]; then \
    url="https://github.com/${LFG_REPO_SLUG}/releases/latest/download/${LFG_RELEASE_ASSET}"; \
  else \
    url="https://github.com/${LFG_REPO_SLUG}/releases/download/${LFG_RELEASE}/${LFG_RELEASE_ASSET}"; \
  fi; \
  curl -fSL "$url" -o /tmp/lfg-bundle.tar.gz; \
  if curl -fsSL "$url.sha256" -o /tmp/lfg-bundle.tar.gz.sha256; then \
    (cd /tmp && sha256sum -c lfg-bundle.tar.gz.sha256); \
  fi; \
  tar -xzf /tmp/lfg-bundle.tar.gz -C /app --strip-components=1; \
  rm -f /tmp/lfg-bundle.tar.gz /tmp/lfg-bundle.tar.gz.sha256; \
  cd /app; \
  bun install --production; \
  mkdir -p /data/repos /data/lfg; \
  rm -rf /app/data; \
  ln -s /data/lfg /app/data

ENV NODE_ENV=production
ENV LFG_INSTALL_CHANNEL=container
ENV LFG_REPO_SLUG=${LFG_REPO_SLUG}
ENV LFG_RELEASE=${LFG_RELEASE}
ENV LFG_RELEASE_ASSET=${LFG_RELEASE_ASSET}
ENV LFG_HOST=0.0.0.0
ENV LFG_PORT=8766
ENV LFG_REPOS_ROOT=/data/repos
EXPOSE 8766

CMD ["sh", "-lc", "LFG_PORT=${PORT:-$LFG_PORT} exec bun run serve"]
