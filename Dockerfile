# syntax=docker/dockerfile:1
#
# Targets:
#   runtime (default)  docker build -t key-vault .
#   migrate            docker build --target migrate -t key-vault-migrate .
#
# Neither the ejson private key nor any secrets file is in the image. At run time mount the key
# read-only at /opt/ejson/keys and the encrypted secrets file at /app/config/secrets.production.ejson
# (or anywhere, with SECRETS_FILE), so one image can be shared without carrying anyone's vault.
# Layout must stay /app/{server/dist,config,web/dist}: config/index.ts resolves the repo root as
# three directories above server/dist/config.

# Base image shared by every stage.
ARG NODE_IMAGE=node:24-alpine

# ---------------------------------------------------------------------------------------------
# build: full dependency tree, compile web + server, generate the Prisma client
# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci --ignore-scripts
COPY . .
RUN npm run db:generate -w server \
 && npm run build

# ---------------------------------------------------------------------------------------------
# migrate: one-shot `prisma migrate deploy` (needs the prisma CLI, a devDependency)
# ---------------------------------------------------------------------------------------------
FROM build AS migrate
ENV NODE_ENV=production
USER node
CMD ["node", "docker/migrate.mjs"]

# ---------------------------------------------------------------------------------------------
# runtime: production dependencies only, non-root
# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8200
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
# --ignore-scripts: no install hooks run in the final image; the generated client is copied below.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/prisma ./server/prisma
COPY --from=build /app/web/dist ./web/dist
USER node
EXPOSE 8200
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8200/healthz >/dev/null || exit 1
CMD ["node", "server/dist/index.js"]
