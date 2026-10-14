# ビルドコンテキストは executors/ (docker build -f executors/gcp-http/Dockerfile executors)
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app/gcp-http
COPY gcp-http/package.json gcp-http/pnpm-lock.yaml gcp-http/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY gcp-http/tsconfig.json gcp-http/tsconfig.build.json ./
COPY shared/package.json ../shared/package.json
COPY shared/src ../shared/src
COPY gcp-http/src ./src
RUN pnpm run build

FROM node:22-slim
ENV NODE_ENV=production
RUN corepack enable
WORKDIR /app
COPY gcp-http/package.json gcp-http/pnpm-lock.yaml gcp-http/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/gcp-http/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/gcp-http/src/server.js"]
