# Minimal, dependency-free OTLP/HTTP JSON emitter.
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY index.js ./

# No dependencies to install — package.json is intentionally dep-free.

# Default target is the in-compose collector; override with --endpoint.
ENTRYPOINT ["node", "index.js"]
CMD ["--scenario", "phase-01", "--endpoint", "http://collector:4318"]
