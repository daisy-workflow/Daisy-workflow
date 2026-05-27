> [!NOTE]
> Transforming Daisy into a more AI-centric workflow. A new release is currently in progress.

Daisy AI Orchestrator is an AI orchestration platform built around a visual editor and a typed DSL. The runtime executes directed acyclic graphs (DAGs) of plugin actions, supports parallel execution with retries and batch fan-out, evaluates FEEL expressions in user-supplied placeholders, and protects credentials with KMS envelope encryption. The platform exposes both in-process and HTTP-transport plugins, supports OIDC authentication, and emits audit, observability, and rate-limit signals suitable for production deployments.

See the [Wiki](https://github.com/vivekg13186/Daisy-workflow/wiki) for full documentation.

# Architecture 
 
 ![arch](daisy-arch.jpg)

## Quick start (Docker)

The fastest way to try Daisy is to pull the pre-built images from Docker Hub and bring the whole stack up with one command.

### Prerequisites

- Docker 24+ and Docker Compose v2 (bundled with Docker Desktop).
- Roughly 1 GB of free RAM for Postgres + Redis + backend + frontend.
- Ports `5173`, `3000`, `5432`, and `6379` free on the host.

### 1. Bring up the stack

Clone the repo (you only need the compose files — the rest comes from Docker Hub):

```bash
git clone https://github.com/vivekg13186/Daisy-workflow.git
cd Daisy-workflow
```

Pull and start everything:

```bash
BACKEND_IMAGE=vivek13186/daisy-workflow-backend:latest \
FRONTEND_IMAGE=vivek13186/daisy-workflow-frontend:latest \
  docker compose --profile full up -d
```

Compose brings up four containers:

| Service        | Image                                       | Host port |
|----------------|---------------------------------------------|-----------|
| `dag_postgres` | `postgres:16-alpine`                        | 5432      |
| `dag_redis`    | `redis:7-alpine`                            | 6379      |
| `dag_backend`  | `vivek13186/daisy-workflow-backend:latest`       | 3000      |
| `dag_frontend` | `vivek13186/daisy-workflow-frontend:latest`      | 5173      |

The backend waits for Postgres + Redis to report healthy before starting. First boot takes ~20 seconds.

For the **dev** images (watch mode, debugger port exposed, looser logging) swap the tag:

```bash
BACKEND_IMAGE=vivek13186/daisy-workflow-backend:dev \
FRONTEND_IMAGE=vivek13186/daisy-workflow-frontend:dev \
  docker compose --profile full up -d
```

If you omit the `BACKEND_IMAGE` / `FRONTEND_IMAGE` env vars, compose builds the images locally from the `Dockerfile`s in `./backend` and `./frontend`.

### 2. Apply database migrations

The schema lives in `backend/migrations/`. Run it once against the freshly-started Postgres:

```bash
docker compose exec backend npm run migrate
```

Migrations are idempotent; rerun any time after `git pull` to pick up new schema.

### 3. Create the first admin user

```bash
docker compose exec backend npm run create-admin
```

The CLI prompts for email + password and creates the user in the default workspace. Rerun to add more admins.

### 4. Open the UI

Point a browser at:

> **http://localhost:5173**

Sign in with the credentials you just created. You'll land on the Home page with sidebar entries for Workflows, Triggers, Agents, Configurations, Instances, and Plugins.

The backend API and WebSocket channel live at:

> **http://localhost:3000** — REST + `/ws` for live execution updates.

### 5. Try a sample workflow

The repo ships sample flows under `backend/samples/`. Import one to make sure the engine is wired correctly:

1. UI → **+ New flow** → toolbar **Import** (upload icon) → pick `backend/samples/hello-world.json`.
2. Click **Save**, then **Run** (▶).
3. The execution opens in the read-only Instance Viewer with the graph coloured by per-node status. You should see every node land on **success** within a second.

### Optional features

| Feature                            | How to enable                                                       |
|------------------------------------|----------------------------------------------------------------------|
| **AI assistant + agents**          | Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in `.env` before `up -d`. The Prompt tab, agent plugin, *Diagnose this failure*, and the Plugin generator all become available. |
| **External plugin containers**     | `docker compose -f docker-compose.yml -f docker-compose.plugins.yml --profile full up -d`. |
| **TLS edge (nginx / Caddy)**       | `docker compose -f docker-compose.yml -f docker-compose.tls.yml --profile full up -d`. See [TLS edge](https://github.com/vivekg13186/Daisy-workflow/wiki/TLS-edge). |
| **Scheduled backups**              | `docker compose -f docker-compose.yml -f docker-compose.backup.yml --profile full up -d`. |
| **Observability (Grafana + Tempo)**| `docker compose -f observability/docker-compose.yml up -d`. |

### Day-to-day commands

```bash
# Status
docker compose ps

# Tail logs (Ctrl+C to stop tailing)
docker compose logs -f backend frontend

# Restart after a config change
docker compose restart backend

# Pull newer images and recreate
docker compose pull
BACKEND_IMAGE=vivek13186/daisy-workflow-backend:latest \
FRONTEND_IMAGE=vivek13186/daisy-workflow-frontend:latest \
  docker compose --profile full up -d

# Shut everything down (volumes preserved)
docker compose down

# Wipe Postgres volume (start over from scratch)
docker compose down -v
```

### Troubleshooting

- **`http://localhost:5173` shows a blank page** — frontend container is still starting. Check `docker compose logs frontend`. The nginx healthcheck takes ~5 s after first boot.
- **`401` from `/api/...`** — you're not signed in. Visit `/login` directly or hard-refresh.
- **`AI button is hidden`** — neither `ANTHROPIC_API_KEY` nor `OPENAI_API_KEY` is set. Visit `http://localhost:3000/ai/status` to see what the backend received.
- **`npm run migrate` fails with `ECONNREFUSED`** — Postgres isn't healthy yet. Wait a few seconds and retry.
- **Want to inspect the DB?** `docker compose exec postgres psql -U dag -d dag_engine`.

For a local-dev setup (no containers, `npm run dev` against host Postgres) see [Getting started](https://github.com/vivekg13186/Daisy-workflow/wiki/Getting-started) on the wiki.

## Screenshots

### Home page

![HomePage](./screenshots/workflows.png)

### Flow designer

![Flow designer](./screenshots/workflow_designer.png)
