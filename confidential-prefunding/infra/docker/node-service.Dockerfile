FROM node:22-trixie-slim

WORKDIR /app
COPY . .
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git python3 make g++ \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*
RUN bash oz-confidential/scripts/install-zk-toolchain.sh
RUN npm install \
  && npm run build \
  && mkdir -p /data

ENV NODE_ENV=production
ENV PATH="/app/oz-confidential/scripts/bin:/root/.nargo/bin:/root/.bb:${PATH}"
