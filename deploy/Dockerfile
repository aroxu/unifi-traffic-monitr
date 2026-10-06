FROM node:24-bookworm-slim
WORKDIR /app
RUN npm install --global pnpm@12.4.1
COPY . .
RUN pnpm install --frozen-lockfile
RUN DATABASE_URL=postgres://build:build@localhost:5432/build BETTER_AUTH_SECRET=build-only-secret-change-at-runtime-0123456789 BETTER_AUTH_URL=http://localhost:3000 pnpm build
EXPOSE 3000
# Start Next.js directly so SIGTERM from docker stop reaches the server, which
# then shuts down cleanly instead of being killed through pnpm.
CMD ["node", "apps/web/node_modules/next/dist/bin/next", "start", "apps/web", "--hostname", "0.0.0.0", "--port", "3000"]
