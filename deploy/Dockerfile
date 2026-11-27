FROM node:24-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig*.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @zhizhi/web run build

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3080

EXPOSE 3080

CMD ["pnpm", "--filter", "@zhizhi/server", "run", "start"]
