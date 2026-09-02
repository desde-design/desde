# Desde Viewer — self-hostable image.
#
# Node 24+ is a hard requirement, not a preference: storage uses `node:sqlite`
# (`DatabaseSync`), which does not exist earlier.
#
# The build runner clones and executes repository code inside this container
# (spec §6, "deploy repos you trust"), so `git` must be present and the image
# is deliberately a full Node base rather than distroless — a repo's own
# `npm ci && npm run build` needs a real userland.

# ---------------------------------------------------------------- build stage
FROM node:24-bookworm-slim AS build
WORKDIR /app

# Install against the lockfile first so a source-only change reuses this layer.
#
# No `*` glob on the lockfiles and no `|| npm install` fallback, both
# deliberate: with the glob, a missing lockfile made the COPY a silent no-op,
# and the fallback then resolved every dependency fresh from the registry —
# so an image that was supposed to be reproducible would quietly install
# whatever happened to be newest, including a compromised release. A missing
# or out-of-sync lockfile must fail the build loudly instead. (Audit K15.)
COPY viewer/package.json viewer/package-lock.json ./viewer/
COPY package.json package-lock.json ./
RUN npm ci --prefix viewer

# The viewer imports shared components from the repo root (`@/components/*`,
# resolved via viewer/tsconfig.json's "@/*" -> "../src/*" path mapping), and
# `next`/`react` themselves live in the ROOT package.json, not viewer's — the
# viewer intentionally doesn't vendor its own copies of the shared shell's
# framework deps. `npm ci --prefix viewer` alone leaves `next` unresolvable
# (no root node_modules in the image, and no npm workspace linking the two),
# so the root tree needs its own install too. This mirrors how it already
# works outside Docker: Node's module resolution walks up from viewer/ to the
# checkout root and finds `next`/`react` there.
RUN npm ci

COPY . .

# Defense in depth for the ignore rules above. `Dockerfile.dockerignore` is a
# BuildKit feature: on the classic builder (old engine, or DOCKER_BUILDKIT=0)
# it is not read at all and `COPY . .` takes the entire checkout — including
# viewer/.env.local, which holds the GitHub App private key, the session
# secret, the client secret, the webhook secret and the admin token. An
# ignore-file edit can regress the same way silently.
#
# So assert it rather than trusting it. This is the control that actually
# holds; the ignore file is the optimization. A hit here means the image WOULD
# have shipped operator credentials, so fail the build loudly instead.
# `.env.example` is exempt — it is a tracked template with no real values.
RUN found="$(find . -name '.env' -o -name '.env.local' -o -name '.env.*.local' -o -name '.env.production' | head -50)"; \
    if [ -n "$found" ]; then \
      echo "FATAL: environment file(s) reached the Docker build context:" >&2; \
      echo "$found" >&2; \
      echo "These would be baked into the image. Check viewer/Dockerfile.dockerignore," >&2; \
      echo "and confirm BuildKit is enabled (DOCKER_BUILDKIT=1)." >&2; \
      exit 1; \
    fi

RUN npm run build --prefix viewer

# ----------------------------------------------------------------- run stage
FROM node:24-bookworm-slim AS run
WORKDIR /app

# `git` for the build runner's clone; `ca-certificates` so it can reach
# GitHub over TLS at all.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3100
ENV VIEWER_DATA_DIR=/data

# `--chown` on the COPY itself, not a `RUN chown -R` after it. A separate
# recursive chown rewrites every inode in /app, which means Docker stores a
# SECOND full copy of the tree as that layer's diff — node_modules included.
# MEASURED on a 2-vCPU VM: the chown alone ran for minutes while the image
# carried a multi-gigabyte duplicate of a tree whose only change was its
# owner. `--chown` sets ownership as the files are written, in one pass.
COPY --from=build --chown=node:node /app /app

# The default `node` user, not root: the build runner executes untrusted
# repository code in this container, so it must not do so as root. /data is
# chowned because SQLite and the disk asset store both write there; it is
# empty at this point, so this one needs no `-R`.
RUN mkdir -p /data && chown node:node /data
USER node

VOLUME ["/data"]
EXPOSE 3100

# `start` (not `dev`) — the dev script runs a file watcher and the Turbopack
# bundler, neither of which belongs in an image.
CMD ["npm", "run", "start", "--prefix", "viewer"]
