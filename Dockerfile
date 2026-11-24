# One image for both services; compose picks the entrypoint.
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY shared ./shared
COPY internal-system/src ./internal-system/src
COPY sync/src ./sync/src
COPY sync/scripts ./sync/scripts
COPY mock-qbo ./mock-qbo
