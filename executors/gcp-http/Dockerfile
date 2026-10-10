# ビルドコンテキストは executors/ (docker build -f executors/gcp-http/Dockerfile executors)
FROM node:22-slim AS build
WORKDIR /app/gcp-http
COPY gcp-http/package.json gcp-http/package-lock.json ./
RUN npm ci
COPY gcp-http/tsconfig.json gcp-http/tsconfig.build.json ./
COPY shared/package.json ../shared/package.json
COPY shared/src ../shared/src
COPY gcp-http/src ./src
RUN npm run build

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY gcp-http/package.json gcp-http/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/gcp-http/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/gcp-http/src/server.js"]
