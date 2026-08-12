FROM node:20-slim AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.34.3 --activate

COPY package.json pnpm-lock.yaml* tsconfig.json ./
RUN pnpm install

COPY . .

RUN pnpm build

FROM node:20-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY --from=builder /app/package.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

EXPOSE 8080

CMD ["node", "dist/index.js"]
