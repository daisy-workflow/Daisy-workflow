# Production image for the Daisy-DAG backend (API + worker).
#
# Multi-stage to keep the runtime layer small — the builder stage pulls
# all deps, the runtime stage copies just node_modules + the source we
# actually run. Final image is ~180MB on node:22-alpine vs ~600MB+ if
# we baked the build cache into one stage.
#
# Runs as the unprivileged `node` user. `tini` reaps zombie children
# from any subprocess the worker spawns.
#
# Build context = ./backend (set in docker-compose.yml). When the
# DOCKERFILE_DIR is ./backend, the `.` paths below resolve correctly.

# ---------- builder ----------
FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies. We don't run npm test here — that's CI's job.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy the application source.
#
# --chmod=0755 forces world-readable + dir-traversable perms because
# COPY otherwise preserves whatever mode the host file had, and on
# some hosts (notably macOS with restrictive umasks, or this repo
# when authored from a sandbox that creates files mode 0600) files
# arrive unreadable to `USER node` (uid 1000) in the runtime image.
# Symptom is `EACCES: permission denied` on every plugin import at
# worker boot. Forcing 0755 makes the image reproducible regardless
# of the build context's umask.
COPY --chmod=0755 src        ./src
COPY --chmod=0755 migrations ./migrations

# ---------- runtime ----------
FROM node:22-alpine AS runtime

# tini is the smallest init that handles SIGTERM + reaps zombies. The
# worker forks the engine; without an init the container leaks.
#
# git + openssh-client back the `git` builtin plugin (clone / pull /
# push / etc.) which shells out to the binaries. ~30MB combined; if
# you don't use the git plugin you can drop them and the image gets
# back to ~180MB.
RUN apk add --no-cache tini git openssh-client

WORKDIR /app

# Carry just what's needed at runtime. node_modules is already
# --omit=dev from the builder stage.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src          ./src
COPY --from=builder /app/migrations   ./migrations
COPY package.json ./

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

# The eventLog module appends to /app/logs/node-events.log. Create the
# directory + chown to `node` BEFORE dropping privileges so the worker
# can write to it. Without this the runtime logs every minute with
# "event log stream error: ENOENT" (harmless — logNodeEvent's
# try/catch keeps the run going — but noisy and obscures real errors).
RUN mkdir -p /app/logs && chown -R node:node /app/logs

# Drop privileges. The `node` user is created by the official image.
USER node

ENTRYPOINT ["tini", "--"]
CMD ["node", "src/server.js"]
