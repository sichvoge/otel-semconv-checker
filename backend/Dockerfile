FROM node:22-alpine

WORKDIR /app

# Install deps against the lockfile first so this layer caches across src edits.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

EXPOSE 3001

CMD ["node", "src/index.js"]
