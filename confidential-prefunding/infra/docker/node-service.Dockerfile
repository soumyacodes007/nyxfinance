FROM node:22-trixie-slim

WORKDIR /app
COPY . .
ARG NEXT_PUBLIC_API_URL=http://localhost:3001
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git python3 make g++ \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*
RUN bash oz-confidential/scripts/install-zk-toolchain.sh

# Rust toolchain + prebuilt runner: demo-flow (fixtures), auditor decrypt, and
# XDR inspection all spawn `cargo run -p oz-confidential-runner` at runtime.
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
ENV PATH="/root/.cargo/bin:${PATH}"
RUN cd oz-confidential && cargo build -q -p oz-confidential-runner

RUN npm install \
  && npm run build \
  && npm --prefix frontend install \
  && npm --prefix frontend run build \
  && mkdir -p /data

ENV NODE_ENV=production
ENV PATH="/app/oz-confidential/scripts/bin:/root/.cargo/bin:/root/.nargo/bin:/root/.bb:${PATH}"
