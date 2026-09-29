# Node 24 LTS: needed for the built-in node:sqlite module and fs.openAsBlob
FROM node:24-alpine AS builder

USER node
WORKDIR /app
COPY --chown=node:node app/ ./

RUN npm ci \
    && npx tsc \
    && npx tsc -p tsconfig.client.json

FROM node:24-alpine AS runner

RUN apk --no-cache add curl \
    && mkdir -p /data/tus \
    && chown -R node:node /data

USER node
WORKDIR /app
COPY --from=builder --chown=node:node app/ ./

RUN npm ci --omit=dev

ARG PACKAGE_VERSION
ARG GIT_SHA
ENV APP_VERSION=${PACKAGE_VERSION}
ENV GIT_SHA=${GIT_SHA}
ENV NODE_ENV=production
# node:sqlite still prints an ExperimentalWarning on every start
ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning
# 3000: public share pages + uploads, 3001: LAN-only admin page
EXPOSE 3000 3001
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD curl -fs http://localhost:3000/share/healthcheck -o /dev/null || exit 1

CMD ["node", "dist/index.js" ]
