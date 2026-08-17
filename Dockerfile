FROM rust:1.88-bookworm AS mrt-decoder-build
WORKDIR /decoder
COPY decoder/baykush-mrt-decoder/Cargo.toml decoder/baykush-mrt-decoder/Cargo.lock ./
COPY decoder/baykush-mrt-decoder/src ./src
RUN cargo build --release --locked

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json tsconfig.test.json eslint.config.mjs vitest.config.ts ./
COPY src ./src
COPY scripts ./scripts
COPY db ./db
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/db ./db
COPY --from=mrt-decoder-build /decoder/target/release/baykush-mrt-decoder /usr/local/bin/baykush-mrt-decoder
RUN mkdir -p /var/lib/baykush/recovery && chown -R node:node /var/lib/baykush
USER node
CMD ["node", "dist/api/main.js"]
