FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY internal-system ./internal-system
CMD ["node", "internal-system/src/main.ts"]
