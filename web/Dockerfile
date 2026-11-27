FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
# Where the APIs live; the defaults are the docker compose service names.
ENV PORT=8080 SYNC_UPSTREAM=http://sync:3000 INTERNAL_UPSTREAM=http://internal-system:3001
COPY default.conf.template /etc/nginx/templates/default.conf.template
COPY 15-resolver.envsh /docker-entrypoint.d/15-resolver.envsh
COPY --from=build /app/dist /usr/share/nginx/html
