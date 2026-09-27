FROM node:24-bookworm-slim
WORKDIR /app
RUN npm install --global pnpm@12.4.1
COPY . .
RUN pnpm install --frozen-lockfile
RUN DATABASE_URL=postgres://build:build@localhost:5432/build BETTER_AUTH_SECRET=build-only-secret-change-at-runtime-0123456789 BETTER_AUTH_URL=http://localhost:3000 pnpm build
EXPOSE 3000
CMD ["pnpm", "--filter", "@utm/web", "start"]
