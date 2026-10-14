# ビルドコンテキストは executors/ (docker build -f executors/home-runner/Dockerfile executors)
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app/home-runner
COPY home-runner/package.json home-runner/pnpm-lock.yaml home-runner/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY home-runner/tsconfig.json home-runner/tsconfig.build.json ./
COPY shared/package.json ../shared/package.json
COPY shared/src ../shared/src
COPY home-runner/src ./src
RUN pnpm run build

FROM node:22-slim
ARG GIT_SHA=dev
ENV NODE_ENV=production \
    GIT_SHA=${GIT_SHA}
WORKDIR /app
COPY home-runner/package.json ./
COPY --from=build /app/home-runner/dist ./dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "dist/home-runner/src/healthcheck.js"]
CMD ["node", "dist/home-runner/src/main.js"]
