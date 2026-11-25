# AGT-17：EAB 单镜像，api / worker 两种角色共用。
#
# 为什么不编译成 dist：本仓当前只有 tsx 运行入口，没有稳定的 build 产物；
# 镜像里保留全量依赖，用 tsx 直接跑 TypeScript，避免容器和本机出现两套启动路径。

FROM node:22-bookworm-slim AS deps
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=1
RUN corepack enable && corepack prepare pnpm@12.16.1 --activate
WORKDIR /app
# 原生依赖（canvas / ffmpeg-static）在无预编译包时需要这些工具链
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/authz/package.json packages/authz/
COPY packages/channel/package.json packages/channel/
COPY packages/domain/package.json packages/domain/
COPY packages/server/package.json packages/server/
COPY packages/storage/package.json packages/storage/
COPY packages/workspace/package.json packages/workspace/
RUN pnpm install --frozen-lockfile

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    EAB_HOME=/data \
    EAB_HOST=0.0.0.0 \
    EAB_PORT=8787 \
    EAB_ADMIN_PORT=8788 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app
RUN groupadd --system --gid 1001 eab \
 && useradd --system --uid 1001 --gid eab --home-dir /data --shell /usr/sbin/nologin eab \
 && mkdir -p /data && chown -R eab:eab /data
COPY --chown=eab:eab --from=deps /app /app
USER eab
VOLUME ["/data"]
EXPOSE 8787 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "packages/server/src/main.ts"]
