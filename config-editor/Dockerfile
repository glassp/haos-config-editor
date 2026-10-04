ARG BUILD_FROM

# --- build the web UI and the server -----------------------------------------
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY server server
COPY web web
RUN npm run build

# --- runtime image -----------------------------------------------------------
FROM ${BUILD_FROM}
RUN apk add --no-cache nodejs npm
WORKDIR /app
COPY --from=build /src/package.json /src/package-lock.json ./
COPY --from=build /src/server/package.json server/
COPY --from=build /src/web/package.json web/
RUN npm ci --omit=dev -w server && npm cache clean --force
COPY --from=build /src/server/dist server/dist
COPY --from=build /src/server/public server/public
COPY run.sh /run.sh
RUN chmod +x /run.sh
CMD ["/run.sh"]
