# Docker — Container Management

You have access to the host's Docker daemon via a mounted socket. Containers you create are **sibling containers** — they run alongside the Codeck sandbox on the same Docker daemon, not nested inside it.

## What you CAN do

- `docker build` — build images from Dockerfiles
- `docker run` — start containers (prefer `--rm` for ephemeral ones)
- `docker compose up/down` — manage multi-container stacks
- `docker ps` — list running containers
- `docker logs` — read container output
- `docker exec` — run commands inside sibling containers
- `docker images` — list available images
- `docker inspect` — examine container/image details
- `docker network ls/create` — manage Docker networks
- `docker cp` — copy files to/from sibling containers

## What you MUST NOT do

- **`docker stop/rm` the Codeck container** — you'd kill yourself. The Codeck container name contains `sandbox` in compose.
- **`docker volume rm`** of `workspace`, `codeck-data`, `claude-config`, or `ssh-data` — these are Codeck's persistent storage. Deleting them erases the user's work, your memory, and credentials.
- **`docker system prune`** — this removes all stopped containers, unused networks, and dangling images. It could delete the user's work.
- **`docker image rm`** of the Codeck image — breaks the system on next restart.
- **`docker compose down` in the Codeck project directory** — kills the sandbox.
- **Modify `docker/compose.isolated.yml`**, `docker/compose.managed.yml`, or `docker/compose.override.yml` directly — use `POST /api/system/add-port` and `POST /api/system/remove-port` for port changes.
- **`claude install`** or **`claude update`** — these modify the CLI binary and can break the system. Use `POST /api/system/update-agent` for controlled updates.

## Best practices

### Always use `--rm` for short-lived containers
```bash
docker run --rm alpine echo "hello"        # Good — auto-cleanup
docker run alpine echo "hello"             # Bad — leaves stopped container
```

### Always name long-running containers
```bash
docker run -d --name my-postgres postgres  # Good — easy to manage
docker run -d postgres                     # Bad — random name, hard to track
```

### Always map ports explicitly
```bash
docker run -d --rm -p 5432:5432 --name my-db postgres     # Good
docker run -d --rm --name my-db postgres                   # Bad — port not reachable
```

### Use `host.docker.internal` to reach sibling containers
From inside this container, sibling container ports are NOT on `localhost`. They're on the host:
```bash
# If a sibling container maps -p 5432:5432
psql -h host.docker.internal -p 5432 -U postgres           # Correct
psql -h localhost -p 5432 -U postgres                       # Wrong — that's THIS container
psql -h 172.18.0.3 -p 5432 -U postgres                     # Wrong — IP changes on restart
```

### Never use container IPs
Container IPs (`172.x.x.x`) are ephemeral — they change on every restart. Always use:
- `localhost:{port}` for services inside this container
- `host.docker.internal:{port}` for sibling containers
- Docker service names only within the same docker-compose network

### Clean up after yourself
```bash
docker ps -a --filter "status=exited"      # Check for stopped containers
docker rm $(docker ps -aq -f status=exited) # Remove them
```

### Resource awareness
The host has finite resources. Before starting heavy containers (databases, build tools):
- Check what's already running: `docker ps`
- Use resource limits when appropriate: `--memory=512m --cpus=1`

## Port mapping: sibling containers vs this container

| Where the service runs | Port mapping | User accesses via |
|------------------------|-------------|-------------------|
| **This container** (dev server started directly) | Needs Codeck port exposure (`/api/system/add-port`) | `localhost:{port}` after mapping |
| **Sibling container** (`docker run -p`) | Port maps directly to host | `localhost:{port}` immediately |

Sibling containers with `-p` are simpler — their ports go straight to the host. Prefer this approach when the service can run in its own container (databases, Redis, etc.).

## Customization

This file defines default Docker rules for the Codeck sandbox. The user can edit it at `/workspace/.codeck/skills/docker.md` to:
- Allow or restrict specific operations
- Add project-specific Docker patterns
- Define custom cleanup policies
