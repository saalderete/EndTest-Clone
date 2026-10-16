# One image for the web app and the test worker. The Playwright base image
# carries Chromium and its system libraries at the version package.json pins.
FROM mcr.microsoft.com/playwright:v1.56.1-noble AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v1.56.1-noble
ENV NODE_ENV=production \
    PORT=5000 \
    ARTIFACT_DIR=/data/artifacts \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
RUN mkdir -p /data/artifacts && chown -R pwuser:pwuser /data
USER pwuser
VOLUME ["/data"]
EXPOSE 5000
# Web by default; the worker service runs `node dist/worker-main.js`.
CMD ["node", "dist/index.js"]
