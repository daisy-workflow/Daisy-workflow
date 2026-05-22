# Tiny image — just Node + the mock script. No deps needed; uses only
# node:http. The image is rebuilt on every `docker compose up --build`
# because COPY changes invalidate the layer cache, but it's <1s.
FROM node:22-alpine

WORKDIR /app
COPY server.js ./

# The compose file maps host port 9124 → container port 9123, but
# inside the docker network containers reach this on `mock-llm:9123`.
EXPOSE 9123

CMD ["node", "server.js"]
