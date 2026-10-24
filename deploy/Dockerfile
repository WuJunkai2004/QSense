# 多阶段构建：build 阶段 tsc+esbuild 产物 → runtime 仅装运行时依赖
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim
# better-sqlite3 无 prebuilt 时需源码编译（python3+make+g++）
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
ENV NODE_ENV=production
# 数据目录（SQLite WAL）挂卷持久化
ENV DATA_DIR=/data
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "dist/index.js"]
