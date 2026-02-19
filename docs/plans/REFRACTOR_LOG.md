# Refactor Log — Codeck

Este archivo registra el progreso y decisiones técnicas.

---

## Estado actual

Branch: refactor/daemon-runtime-gateway
Modo objetivo: local + gateway
Último bloque completado: MILESTONE 5 — CLI

---

## Iteraciones

### Iteración 1 — MILESTONE 0: PREPARACIÓN
**Fecha:** 2026-02-19

**Bloque:** Milestone 0 — Preparación del monorepo

**Cambios:**
- Creada estructura de directorios: `apps/{web,daemon,runtime,cli}`, `packages/{shared,protocols}`, `container/`
- Agregado `turbo.json` con tasks: build, dev, clean, test
- Configurado `workspaces` en root `package.json` apuntando a `apps/*` y `packages/*`
- Creado `packages/shared` con package.json, tsconfig.json e `index.ts` stub (`@codeck/shared`)
- Creado `packages/protocols` con package.json, tsconfig.json e `index.ts` stub (`@codeck/protocols`), con dependencia a `@codeck/shared`
- Creados package.json placeholder en cada app (`@codeck/web`, `@codeck/daemon`, `@codeck/runtime`, `@codeck/cli`)
- Ejecutado `npm install` para vincular los 6 workspaces

**Problemas:** Ninguno.

**Decisiones:**
- Las apps llevan package.json con build scripts de placeholder (echo) — se reemplazan en sus milestones respectivos
- `@codeck/protocols` depende de `@codeck/shared` desde el inicio (por diseño del plan)
- No se movió código existente; el root package.json sigue siendo el punto de entrada funcional y el build existente no se alteró
- Se verificó que `npm run build` (frontend + backend) sigue funcionando sin regresión
- `.gitignore` ya cubre `dist` y `.turbo` globalmente, no se necesitaron cambios

**Smoke test:** `npm run build` — OK (frontend vite + backend tsc + copy:templates)

---

### Iteración 2 — MILESTONE 1: WEBAPP
**Fecha:** 2026-02-19

**Bloque:** Milestone 1 — Mover SPA a apps/web

**Cambios:**
- Movidos archivos frontend de `src/web/` a `apps/web/`: `index.html`, `vite.config.ts`, `tsconfig.json`, `public/`, `src/`
- Backend files (`server.ts`, `websocket.ts`, `logger.ts`) permanecen en `src/web/` (son compilados por tsc)
- Actualizado `apps/web/vite.config.ts`: outDir cambiado de `../../dist/web/public` a `dist` (output local a `apps/web/dist/`)
- Actualizado `apps/web/package.json`: dependencias frontend (preact, signals, xterm, dompurify), devDeps (vite, preset-vite), scripts reales (`vite build`, `vite`)
- Removidas dependencias frontend-only del root `package.json` (preact, @preact/signals, @xterm/xterm, @xterm/addon-fit, dompurify, @preact/preset-vite, @testing-library/preact)
- Actualizado root `package.json` build:frontend script: `npm run build -w @codeck/web` (usa npm workspaces)
- Actualizado root `tsconfig.json`: exclusión simplificada a `["apps"]` (ya no existe `src/web/src` etc.)
- Actualizado `src/web/server.ts`: rutas de static files y SPA catch-all apuntan a `apps/web/dist/` en vez de `__dirname/public`

**Problemas:** Ninguno.

**Decisiones:**
- Los archivos backend (`server.ts`, `websocket.ts`, `logger.ts`) permanecen en `src/web/` porque son parte del backend compilado por tsc del root. Se migrarán en Milestone 2 (Runtime)
- Las dependencias frontend se mueven a `apps/web/package.json` para aislar el workspace. npm workspaces hoistea al root `node_modules/`
- El vite dev proxy (`/api` → `localhost:8080`, `/ws` → `ws://localhost:8080`) se mantiene — es configuración de desarrollo solamente
- No se encontraron hardcodes de host en código de producción. Todas las API calls usan rutas relativas `/api/...`, WebSocket usa `location.host` dinámicamente
- El `tsconfig.json` root excluye `apps` completo para evitar que tsc intente compilar código JSX del frontend

**Smoke test:** `npm run build` — OK (frontend vite build → apps/web/dist + backend tsc + copy:templates). Startup test confirmó resolución correcta de paths.

---

### Iteración 3 — MILESTONE 2.1: RUNTIME SERVER BASE
**Fecha:** 2026-02-19

**Bloque:** Milestone 2.1 — Crear apps/runtime, /internal/status, servir web en local mode

**Cambios:**
- Migrado todo el backend de `src/` a `apps/runtime/src/` via `git mv` (preserva historial):
  - `src/index.ts` → `apps/runtime/src/index.ts`
  - `src/web/{server,websocket,logger}.ts` → `apps/runtime/src/web/`
  - `src/routes/*.ts` → `apps/runtime/src/routes/`
  - `src/services/*.ts` → `apps/runtime/src/services/`
  - `src/templates/` → `apps/runtime/src/templates/`
- Creado `apps/runtime/tsconfig.json` con misma configuración que root (ES2022, NodeNext, strict)
- Actualizado `apps/runtime/package.json` con dependencias reales (express, helmet, ws, node-pty, etc.), scripts de build (`tsc && copy:templates`), y optionalDependencies
- Removidas dependencias backend del root `package.json` — ahora viven solo en `@codeck/runtime`
- Actualizado root `package.json`: build:backend usa workspace (`npm run build -w @codeck/runtime`), start/dev apuntan a `apps/runtime/dist/index.js`
- Root `tsconfig.json` convertido a config base inerte (sin archivos propios, sin outDir/rootDir)
- Agregado endpoint `/internal/status` en server.ts — retorna `{ status: "ok", uptime: <seconds> }`, registrado antes del auth middleware
- Actualizado static file serving: usa constante `WEB_DIST` calculada desde `__dirname` (`../../../web/dist`)
- Actualizado `Dockerfile`: COPY paths a `apps/runtime/dist/`, `apps/web/dist/`, templates; ENTRYPOINT a `apps/runtime/dist/index.js`
- Actualizado `Dockerfile.dev`: COPY sources desde `apps/`, dist output desde workspace paths
- Actualizados scripts de deploy: `codeck.service`, `install.sh`, `dev-setup.sh` — ExecStart apunta a `apps/runtime/dist/index.js`

**Problemas:** Ninguno.

**Decisiones:**
- Se usa `git mv` para todos los movimientos — preserva historial de git y permite detectar renames
- El directorio `src/` se elimina completamente; ya no existe en el repo
- `/internal/status` se registra ANTES del auth middleware — es un endpoint interno para health checks del daemon, no requiere autenticación
- Las rutas relativas internas entre services/routes/web no cambian — la estructura interna de `src/` se mantuvo idéntica dentro de `apps/runtime/src/`
- Las dependencias de backend se mueven completamente al workspace `@codeck/runtime`; el root solo mantiene devDeps compartidas (vitest, typescript, tsx, vite)
- El root tsconfig.json queda como config base sin compilar nada — cada workspace tiene su propio tsconfig
- La ruta a `apps/web/dist/` se calcula con `WEB_DIST = join(__dirname, '../../../web/dist')` desde `apps/runtime/dist/web/server.js`

**Smoke test:** `npm run build` — OK (frontend vite → apps/web/dist + backend tsc → apps/runtime/dist + copy:templates). Startup test en port 9999 confirmó: `/internal/status` → `{"status":"ok","uptime":3.02}`, `/api/auth/status` → `{"configured":true}`, SPA catch-all → HTTP 200. Shutdown limpio con todos los servicios.

---

### Iteración 4 — MILESTONE 2.2: PTY
**Fecha:** 2026-02-19

**Bloque:** Milestone 2.2 — PTY (node-pty, WS /internal/pty/:id, session limits)

**Cambios:**
- Refactorizado WebSocket upgrade handling: movido el `server.on('upgrade')` de `websocket.ts` a `server.ts` con ruteo por path
  - `setupWebSocket()` ya no recibe `server` — crea el WSS sin binding automático
  - Exportada `handleWsUpgrade(req, socket, head)` para manejar upgrades del endpoint `/ws` existente
  - `server.ts` centraliza el upgrade routing: `/internal/pty/*` → internal PTY handler, todo lo demás → WS handler existente
- Creado `apps/runtime/src/web/internal-pty.ts` — endpoint WebSocket per-session `/internal/pty/:id`
  - Protocolo simplificado: `input`, `output`, `resize`, `exit`, `error` (sin sessionId en mensajes, implícito en URL)
  - Auto-attach al conectar (sin necesidad de mensaje `console:attach`)
  - Multi-client support con tracking de dimensiones y max resize (misma lógica que `/ws`)
  - Rate limiting (300 msg/min), ping/pong keepalive (30s)
  - Validación UUID del session ID en URL
  - Sin auth — endpoint interno, el runtime no está expuesto en gateway mode
- Hecho configurable el límite de sesiones concurrentes:
  - `MAX_SESSIONS` exportado desde `console.ts`, lee de env var `MAX_SESSIONS` (default: 5)
  - `console.routes.ts` usa `MAX_SESSIONS` en vez de `5` hardcodeado (ambas rutas: create y create-shell)

**Problemas:** Ninguno.

**Decisiones:**
- El upgrade routing se centraliza en `server.ts` para permitir múltiples WebSocket servers en un solo HTTP server
- `/internal/pty/:id` no requiere autenticación: es un endpoint interno para el daemon, el runtime no está expuesto en gateway mode
- El protocolo de `/internal/pty/:id` es intencionalmente distinto al de `/ws` — más simple, sin prefijo `console:`, sin `sessionId` en los mensajes
- Los dos endpoints (`/ws` y `/internal/pty/:id`) tienen tracking de estado independiente — son mutuamente excluyentes por diseño (local mode usa `/ws`, gateway mode usa `/internal/pty/:id`)
- `MAX_SESSIONS` se lee una vez al startup desde env var — no es dinámico, pero es suficiente para configuración por deployment

**Smoke test:** `npm run build` — OK. Startup en port 9999: `/internal/status` → `{"status":"ok","uptime":3.01}`, `/api/auth/status` → `{"configured":true}`. Shutdown limpio.

---

### Iteración 5 — MILESTONE 2.3: FILESYSTEM
**Fecha:** 2026-02-19

**Bloque:** Milestone 2.3 — Filesystem (read/write/list/delete/rename)

**Cambios:**
- Agregados dos nuevos endpoints a `apps/runtime/src/routes/files.routes.ts`:
  - `DELETE /api/files/delete` — elimina un archivo o directorio vacío
  - `POST /api/files/rename` — renombra/mueve un archivo o directorio
- Importados `unlink`, `rmdir`, `rename` de `fs/promises`
- Actualizado `docs/API.md` con la documentación de los nuevos endpoints

**Problemas:** Ninguno.

**Decisiones:**
- `DELETE /api/files/delete` usa `rmdir` para directorios (solo vacíos) y `unlink` para archivos — no permite eliminación recursiva por seguridad
- Ambos endpoints previenen operaciones sobre el workspace root (`fullPath === WORKSPACE`)
- `POST /api/files/rename` valida ambos paths (oldPath y newPath) con `safePath()` — ambos deben estar dentro del workspace
- Ambos endpoints llaman `broadcastStatus()` tras la operación exitosa (mismo patrón que `mkdir`)
- Se preservan los read/write/list existentes sin modificación — ya estaban completos
- No se agregan delete/rename a las rutas de agent data (`codeck.routes.ts`) — ese scope es intencionalmente restrictivo (solo lectura/escritura de archivos existentes)

**Smoke test:** `npm run build` — OK (frontend vite → apps/web/dist + backend tsc → apps/runtime/dist + copy:templates). Startup en port 9999: `/internal/status` → `{"status":"ok","uptime":3.04}`, `/api/auth/status` → `{"configured":true}`. Shutdown limpio.

---

### Iteración 6 — MILESTONE 2.4: PROACTIVE AGENTS
**Fecha:** 2026-02-19

**Bloque:** Milestone 2.4 — Proactive Agents (CRUD, Scheduler, Events)

**Cambios:**
- Verificación de completitud: todo el subsistema de proactive agents ya fue migrado en milestone 2.1 (git mv de `src/` a `apps/runtime/src/`)
- No se requirieron cambios de código — la implementación existente cubre los tres puntos del milestone

**Componentes verificados:**
- **CRUD**: `proactive-agents.ts` exporta `createAgent`, `getAgent`, `listAgents`, `updateAgent`, `deleteAgent` — rutas REST completas en `agents.routes.ts` (POST/GET/PUT/DELETE `/api/agents`)
- **Scheduler**: `node-cron` integrado con `scheduleCron`, `stopCron`, `computeNextRun`, queue por cwd, misfire detection, max concurrency (2), max agents (10)
- **Eventos**: WebSocket broadcast de `agent:update`, `agent:execution:start`, `agent:execution:complete`, `agent:output`, `agent:misfire` — cubren create/update/delete/run del plan
- **Wiring en server.ts**: import (L37-38), route registration (L288), init (L379), shutdown (L329) — todo correcto

**Problemas:** Ninguno.

**Decisiones:**
- Este milestone no requirió cambios de código porque el subsistema completo fue migrado intacto en 2.1 (via `git mv` que preservó toda la estructura interna de `src/`)
- Los "Eventos create/update/delete/run" del plan se interpretan como los WebSocket broadcasts existentes, no como audit log entries (el audit log JSONL es parte de Milestone 3.3 — Daemon)
- La persistencia de agents en `/workspace/.codeck/agents/` ya estaba funcionando (2 agents activos restaurados en startup test)
- Dependencia `node-cron@^3.0.3` ya está en `apps/runtime/package.json`

**Smoke test:** `npm run build` — OK (frontend vite → apps/web/dist + backend tsc → apps/runtime/dist + copy:templates). Startup en port 9999: `/internal/status` funcionando, 2 agents restaurados correctamente (`Polymarket Bot`, `Codeck Refactor Implementation`), cron scheduling activo. Shutdown limpio con `[ProactiveAgents] Shutdown complete (2 agents)`.

---

### Iteración 7 — MILESTONE 2.5: MEMORY/INDEX
**Fecha:** 2026-02-19

**Bloque:** Milestone 2.5 — Memory/Index (migrar implementación existente)

**Cambios:**
- Verificación de completitud: todo el subsistema de memory/index ya fue migrado en milestone 2.1 (git mv de `src/` a `apps/runtime/src/`)
- No se requirieron cambios de código — la implementación existente cubre todos los puntos del milestone
- **MILESTONE 2 — RUNTIME está ahora COMPLETO**

**Componentes verificados:**
- **memory.ts** (656 líneas): Persistencia file-based — durable memory, daily journals, ADRs, path-scoped memory con SHA-256 pathIds, legacy migration, flush, context assembly
- **memory-indexer.ts** (511 líneas): SQLite FTS5 indexer con file watcher, markdown/JSONL chunking, sqlite-vec opcional para embeddings
- **memory-search.ts** (256 líneas): BM25 full-text search, hybrid search con Reciprocal Rank Fusion, filtrado por scope/pathId/project/date
- **memory-context.ts** (173 líneas): Context injection para sesiones nuevas, inyecta memoria en `/workspace/CLAUDE.md`
- **memory.routes.ts** (454 líneas): API REST completa — durable CRUD, daily, decisions, paths, promote, flush, sessions, search, context, backward compat
- **Wiring en server.ts**: imports (L25-30), route registration (L281), init (L374-376), shutdown (L330-332), ensureDirectories (L363), localhost auth bypass (L213-217)

**Problemas:** Ninguno.

**Decisiones:**
- Este milestone no requirió cambios de código — el subsistema completo fue migrado intacto en 2.1 (via `git mv`)
- El indexer SQLite FTS5 y el vector search (sqlite-vec) están operacionales — 47 archivos indexados, 231 chunks
- La búsqueda híbrida BM25 + vector con RRF está funcional
- Los 3 path scopes están registrados y funcionando
- El auth bypass para localhost (127.0.0.1) permite a los agents llamar `/api/memory/*` sin token
- Con esto se completa MILESTONE 2 — el runtime tiene feature parity con el sistema original

**Smoke test:** `npm run build` — OK (frontend vite → apps/web/dist + backend tsc → apps/runtime/dist + copy:templates). Startup en port 9999: `/internal/status` → `{"status":"ok","uptime":4.01}`, `/api/memory/status` → `{"durableExists":true,"dailyCount":1,"pathScopes":3}`, `/api/memory/search?q=codeck` → resultados encontrados, `/api/memory/search/stats` → `{"available":true,"fileCount":47,"chunkCount":231}`. Shutdown limpio.

---

### Iteración 8 — MILESTONE 3.1: DAEMON SERVER BASE
**Fecha:** 2026-02-19

**Bloque:** Milestone 3.1 — Daemon server base (apps/daemon en :8080, servir web estática, /api/ui/status)

**Cambios:**
- Actualizado `apps/daemon/package.json` de placeholder a configuración real: dependencias (express, helmet), devDeps (@types/express, @types/node), scripts (tsc build), main apunta a `dist/index.js`
- Creado `apps/daemon/tsconfig.json` — idéntico al de runtime (ES2022, NodeNext, strict)
- Creado `apps/daemon/src/index.ts` — entry point minimal, delega a `startDaemon()`
- Creado `apps/daemon/src/server.ts` — servidor Express con:
  - Puerto configurable via `CODECK_DAEMON_PORT` (default: 8080)
  - `helmet()` con misma configuración que runtime
  - `GET /api/ui/status` → `{ status: "ok", mode: "gateway", uptime: <seconds> }`
  - Static file serving desde `apps/web/dist/` (misma estrategia de cache que runtime)
  - SPA catch-all para client-side routing
  - Error handler centralizado (CWE-209 safe)
  - Graceful shutdown con SIGTERM/SIGINT y timeout de 5s
- Actualizado root `package.json`: agregado script `build:daemon` (`npm run build -w @codeck/daemon`)

**Problemas:** Ninguno.

**Decisiones:**
- El daemon usa `createServer(app)` en vez de `app.listen()` — anticipa WebSocket upgrade handling en milestone 3.6
- La ruta de web estática es `join(__dirname, '../../web/dist')` desde `apps/daemon/dist/` — diferente a runtime que es `../../../web/dist` (runtime tiene un nivel más de profundidad por su subdirectorio `web/`)
- `/api/ui/status` expone `mode: "gateway"` — esto permitirá al frontend detectar el modo sin hardcodes en futuras iteraciones
- No se incluyen devDependencies de tsx/typescript en el daemon — se heredan del root workspace
- El daemon NO tiene autenticación propia aún — eso es milestone 3.2
- El daemon NO proxea requests al runtime aún — eso es milestone 3.5/3.6
- El `trust proxy` está habilitado (`app.set('trust proxy', 1)`) porque en gateway mode hay nginx delante del daemon

**Smoke test:** `npm run build` — OK (frontend vite → apps/web/dist + backend tsc → apps/runtime/dist + daemon tsc → apps/daemon/dist). Startup en port 9998: `/api/ui/status` → `{"status":"ok","mode":"gateway","uptime":2.01}`, SPA catch-all → HTTP 200. Shutdown limpio.

---

### Iteración 9 — MILESTONE 3.2: AUTH + SESIONES
**Fecha:** 2026-02-19

**Bloque:** Milestone 3.2 — Auth + sesiones (login/logout, listar sesiones, revoke, deviceId, lastSeen)

**Cambios:**
- Creado `apps/daemon/src/services/auth.ts` — servicio de autenticación completo para el daemon:
  - Lee `auth.json` compartido con runtime (misma contraseña, mismo scrypt) via `CODECK_DIR` env var
  - Sesiones propias persistidas en `daemon-sessions.json` (separadas de runtime)
  - `SessionData` incluye `deviceId` y `lastSeen` (extensiones vs runtime)
  - Verificación de password con soporte legacy SHA-256 y scrypt (timing-safe comparison)
  - Auth event log circular (200 entries max)
  - `touchSession()` con debounce de 60s para actualizar `lastSeen` sin I/O excesivo
  - `atomicWriteFileSync` local (no depende de runtime)
- Actualizado `apps/daemon/src/server.ts` — endpoints de auth y middleware:
  - **Públicos (sin auth):** `GET /api/auth/status`, `POST /api/auth/login` (acepta `deviceId`)
  - **Protegidos:** `POST /api/auth/logout`, `GET /api/auth/sessions`, `DELETE /api/auth/sessions/:id`, `GET /api/auth/log`
  - Auth middleware en `/api` con soporte Bearer header y `?token=` query param
  - `touchSession()` llamado en cada request autenticado (actualiza `lastSeen`)
  - Rate limiting: 10 req/min por IP en auth endpoints, cleanup cada 5 min
  - Brute-force lockout: 5 intentos fallidos → 15 min lockout por IP
  - Cleanup del rate interval en graceful shutdown

**Problemas:** Ninguno.

**Decisiones:**
- El daemon NO gestiona password setup/change — eso es responsabilidad exclusiva del runtime. El daemon solo lee `auth.json` y valida contra él
- Las sesiones del daemon son completamente independientes de las del runtime — archivos separados, maps separados. Un login en runtime no crea sesión en daemon y viceversa
- El daemon NO hace opportunistic rehash de passwords legacy — eso lo hace el runtime cuando el usuario hace login ahí. El daemon es read-only respecto al hash
- `deviceId` se recibe como parámetro del `POST /api/auth/login` body — es responsabilidad del frontend generar y persistir un deviceId estable (localStorage UUID)
- `lastSeen` se actualiza via `touchSession()` con debounce de 60s para evitar escrituras a disco en cada request. El timer usa `.unref()` para no bloquear el shutdown
- La lista de sesiones se ordena por `lastSeen` (desc) en vez de `createdAt` — más útil para el usuario
- No se implementa `POST /api/auth/setup` en el daemon — la configuración inicial de password se hace via runtime en modo local, antes de exponer el daemon como gateway

**Smoke test:** `npm run build` — OK (frontend + runtime). `npm run build:daemon` — OK. Startup en port 9997: `/api/auth/status` → `{"configured":true}`, `/api/auth/login` → rechaza password incorrecto (401), `/api/auth/sessions` → protegido (401 sin auth), `/api/auth/log` → protegido (401 sin auth), `/api/ui/status` → público, SPA catch-all → HTTP 200. Shutdown limpio.

---

### Iteración 10 — MILESTONE 3.3: AUDITORÍA
**Fecha:** 2026-02-19

**Bloque:** Milestone 3.3 — Auditoría (audit.log JSONL, eventos auth)

**Cambios:**
- Creado `apps/daemon/src/services/audit.ts` — servicio de auditoría append-only JSONL:
  - `audit(event, actor, opts?)` — API principal, acepta event type, IP, y opciones (sessionId, deviceId, metadata)
  - Formato JSONL: cada línea es un JSON con `timestamp` (ISO 8601), `event`, `sessionId`, `deviceId`, `actor`, `metadata`
  - Escritura buffered: acumula hasta 20 entries o 5 segundos antes de hacer append al archivo
  - `flushAudit()` para vaciar el buffer en shutdown
  - Archivo: `CODECK_DIR/audit.log` con permisos 0o600
- Actualizado `apps/daemon/src/services/auth.ts`:
  - `validatePassword()` ahora retorna `sessionId` y `deviceId` en el resultado de login exitoso
  - Nuevas funciones `getSessionByToken(token)` y `getSessionById(sessionId)` para lookup de sesiones (necesarias para audit en logout/revoke)
- Actualizado `apps/daemon/src/server.ts`:
  - Import de `audit` y `flushAudit`
  - Import de `getSessionByToken` y `getSessionById`
  - `auth.login` emitido en login exitoso (con sessionId, deviceId)
  - `auth.login_failure` emitido en login fallido (con deviceId del intento)
  - `auth.logout` emitido en logout (con sessionId y deviceId de la sesión terminada)
  - `auth.session_revoked` emitido en revoke (con sessionId del actor y metadata del revoked)
  - `flushAudit()` llamado en graceful shutdown

**Problemas:** Ninguno.

**Decisiones:**
- El audit log es append-only JSONL — no se usa rotation ni truncation por ahora (la rotation se puede agregar después con logrotate o un mecanismo interno si el archivo crece mucho)
- La escritura es buffered (5s / 20 entries) para evitar I/O sincrónico en cada request — el buffer se vacía en shutdown con `flushAudit()`
- Los event types definidos para auth: `auth.login`, `auth.login_failure`, `auth.logout`, `auth.session_revoked` — los tipos para pty/files/proactive se agregarán cuando el proxy (milestone 3.5/3.6) permita interceptar esas operaciones
- El campo `actor` es siempre la IP del request — no hay concepto de "username" en Codeck (single-user system)
- `metadata` es opcional y se usa para información adicional (e.g., en `session_revoked` incluye el ID de la sesión revocada)
- `sessionId` es null en `auth.login_failure` porque no hay sesión asociada a un intento fallido

**Smoke test:** `npm run build` — OK (frontend + runtime). `npm run build:daemon` — OK. Startup en port 9997: `/api/auth/status` → `{"configured":true}`, login fallido genera audit entry, shutdown genera flush a `audit.log`. Verificado contenido JSONL: `{"timestamp":"...","event":"auth.login_failure","sessionId":null,"deviceId":"test-device-1","actor":"::1"}`. Shutdown limpio.

---

### Iteración 11 — MILESTONE 3.4: RATE LIMIT
**Fecha:** 2026-02-19

**Bloque:** Milestone 3.4 — Rate limit (auth agresivo, writes moderado, configurable por env)

**Cambios:**
- Creado `apps/daemon/src/services/rate-limit.ts` — servicio de rate limiting reutilizable:
  - Clase `RateLimiter` con sliding window per-IP, cleanup automático cada 5 min, `destroy()` para shutdown
  - `createAuthLimiter()` — agresivo: 10 req/min (env: `RATE_AUTH_MAX`, `RATE_AUTH_WINDOW_MS`)
  - `createWritesLimiter()` — moderado: 60 req/min (env: `RATE_WRITES_MAX`, `RATE_WRITES_WINDOW_MS`)
  - Brute-force lockout extraído de server.ts: `checkLockout`, `recordFailedLogin`, `clearFailedAttempts` (env: `LOCKOUT_THRESHOLD`, `LOCKOUT_DURATION_MS`)
- Refactorizado `apps/daemon/src/server.ts`:
  - Eliminado rate limiting y lockout inline (~60 líneas) — reemplazado por imports del servicio
  - Nuevo middleware writes rate limiter: aplica a POST/PUT/DELETE en `/api/*` (excluye auth/ y GET/HEAD/OPTIONS)
  - Graceful shutdown llama `authLimiter.destroy()` y `writesLimiter.destroy()` (libera timers)

**Problemas:** Ninguno.

**Decisiones:**
- La clase `RateLimiter` es genérica y reutilizable — se puede instanciar con cualquier config. Las factories `createAuthLimiter` y `createWritesLimiter` encapsulan los defaults con env vars
- Todos los parámetros son configurables via env vars sin necesidad de cambiar código:
  - `RATE_AUTH_MAX` (default 10), `RATE_AUTH_WINDOW_MS` (default 60000)
  - `RATE_WRITES_MAX` (default 60), `RATE_WRITES_WINDOW_MS` (default 60000)
  - `LOCKOUT_THRESHOLD` (default 5), `LOCKOUT_DURATION_MS` (default 900000)
- El writes limiter se aplica DESPUÉS del auth middleware — solo requests autenticados llegan al writes limiter (no malgasta capacidad en requests no autenticados)
- Los endpoints auth (login/logout) están excluidos del writes limiter porque ya tienen su propio limiter más agresivo
- El brute-force lockout es un mecanismo separado del rate limiter — se complementan pero no se superponen (rate limit = ventana, lockout = threshold acumulativo)

**Smoke test:** `npm run build` — OK (frontend + runtime). `npm run build:daemon` — OK. Startup con `RATE_AUTH_MAX=3`: primeras 3 requests pasan normalmente, 4ta request → 429 `"Too many requests"`. Endpoints públicos no afectados. Shutdown limpio.

---

### Iteración 12 — MILESTONE 3.5: PROXY HTTP
**Fecha:** 2026-02-19

**Bloque:** Milestone 3.5 — Proxy HTTP (/api/* → runtime internal)

**Cambios:**
- Creado `apps/daemon/src/services/proxy.ts` — reverse proxy HTTP al runtime:
  - `proxyToRuntime(req, res)` — proxea un Express request al runtime, re-serializa `req.body` (consumido por `express.json()`)
  - Strips hop-by-hop headers, `Authorization` (daemon's token), y `Host`
  - Agrega `X-Forwarded-For`, `X-Forwarded-Proto`, `X-Forwarded-Host`
  - Timeout configurable via `PROXY_TIMEOUT_MS` (default: 30s)
  - Manejo de errores: 502 si runtime no disponible, 504 si timeout
  - `checkRuntime()` — health check async contra `/internal/status` del runtime
  - `getRuntimeUrl()` — getter para logging
- Actualizado `apps/daemon/src/server.ts`:
  - Import de `proxyToRuntime` y `getRuntimeUrl`
  - Catch-all `app.use('/api', ...)` después de los endpoints daemon-owned — proxea todo `/api/*` que el daemon no maneja
  - Startup log muestra runtime URL: `[Daemon] Proxying API to <url>`

**Problemas:** Ninguno.

**Decisiones:**
- URL del runtime configurable via `CODECK_RUNTIME_URL` (default: `http://codeck-runtime:7777` — hostname del container Docker en la red privada `codeck_net`)
- El proxy strip el header `Authorization` porque el daemon tiene sus propias sesiones — el runtime no entiende los tokens del daemon. En gateway mode, el runtime confiará en la red privada (solo el daemon puede hablarle)
- La re-serialización de `req.body` es necesaria porque `express.json()` consume el stream al parsear. Esto funciona para toda la API de Codeck que es 100% JSON. File uploads (si se agregan en el futuro) necesitarían un middleware que capture el raw body
- El proxy catch-all va DESPUÉS de todos los endpoints daemon-owned y ANTES del static files/SPA — así el daemon maneja auth, ui/status, sessions, etc. y todo lo demás va al runtime
- No se implementa proxy de WebSocket en este milestone — eso es 3.6
- Se incluyó `checkRuntime()` (health check) como utilidad para futuro uso en `/api/ui/status` (mostrar si runtime está healthy)

**Smoke test:** `npm run build` — OK (frontend + runtime). `npm run build:daemon` — OK. Startup con `CODECK_RUNTIME_URL=http://localhost:9996`:
- Daemon-owned: `/api/ui/status` → `{"status":"ok","mode":"gateway"}`, `/api/auth/status` → `{"configured":false}`
- Proxied to runtime: `POST /api/auth/setup` → `{"error":"Password already configured"}` (runtime's 400 response forwarded correctly)
- SPA catch-all → HTTP 200
- Startup log: `[Daemon] Proxying API to http://localhost:9996`
- Shutdown limpio.

---

### Iteración 13 — MILESTONE 4: NETWORKING
**Fecha:** 2026-02-19

**Bloque:** Milestone 4 — Networking (docker network, container names, internal ports, daemon connection)

**Cambios:**
- **Runtime: puerto WS separado** — Agregado `CODECK_WS_PORT` env var a `apps/runtime/src/web/server.ts`:
  - Si está definido y es diferente de `CODECK_PORT`, crea un segundo HTTP server dedicado a WebSocket upgrades
  - Si no está definido, comportamiento idéntico al actual (WS y HTTP en el mismo server)
  - Startup log muestra `WS: :PORT` cuando está configurado
  - Graceful shutdown cierra ambos servers
- **Daemon: URL WS separada** — Agregado `CODECK_RUNTIME_WS_URL` env var a `apps/daemon/src/services/ws-proxy.ts`:
  - Default: usa `CODECK_RUNTIME_URL` (mismo URL para HTTP y WS)
  - Cuando está configurado, WS proxy conecta a URL diferente (e.g., `codeck-runtime:7778`)
  - Startup log muestra URL WS cuando difiere de la URL HTTP
  - Exportado `getRuntimeWsUrl()` para logging
- **Dockerfile + Dockerfile.dev**: Agregado `COPY apps/daemon/dist` para incluir daemon en la imagen
- **docker-compose.gateway.yml**: Creado compose file para gateway mode:
  - Red `codeck_net` (bridge driver)
  - Servicio `runtime`: `container_name: codeck-runtime`, sin puertos expuestos al host, `CODECK_PORT=7777`, `CODECK_WS_PORT=7778`
  - Servicio `daemon`: expuesto en `:8080`, conecta a runtime por nombre (`http://codeck-runtime:7777/7778`)
  - Runtime tiene full capabilities (PTY, Docker socket, volumes), daemon es minimal (256MB, solo NET_BIND_SERVICE)
- **Root package.json**: Actualizado `build` script para incluir `build:daemon`

**Problemas:** Ninguno.

**Decisiones:**
- El puerto WS separado es **opcional** — controlado por `CODECK_WS_PORT`. Si no está definido, el runtime funciona como siempre (local mode). Esto preserva compatibilidad total con el modo existente
- El segundo HTTP server para WS solo acepta WebSocket upgrades; cualquier request HTTP normal recibe `426 Upgrade Required`
- La imagen Docker es compartida entre daemon y runtime (same image, different entrypoints). Esto simplifica builds y es suficiente para el estado actual. Optimización de tamaño de imagen (separar) puede hacerse en futuro si es necesario
- El daemon en gateway mode es lightweight: 256MB memory limit, 0.5 CPU, sin Docker socket, sin PTY capabilities
- El runtime en gateway mode NO tiene puertos expuestos al host — solo es alcanzable via `codeck_net`. Esto cumple el requisito de seguridad: "runtime nunca debe estar expuesto en gateway mode"
- Se usa `bridge` network driver (no `internal`) porque el runtime necesita acceso a internet para operaciones como `npm install`, `git clone`, etc. dentro de los proyectos
- Los volumes son compartidos entre daemon y runtime para que el daemon pueda leer `auth.json` de `/workspace/.codeck/`

**Smoke test:** `npm run build` — OK (frontend vite → apps/web/dist + backend tsc → apps/runtime/dist + daemon tsc → apps/daemon/dist).
- Runtime con WS separado (ports 9995/9994): startup OK, muestra `WS: :9994`, WS server listening confirmado
- Runtime sin WS (port 9992): startup OK, sin línea WS — local mode sin cambios
- Daemon con WS URL separada (port 9993): startup OK, muestra `Proxying WS to http://localhost:9994`

---

### Iteración 14 — MILESTONE 5: CLI
**Fecha:** 2026-02-19

**Bloque:** Milestone 5 — CLI (codeck init, codeck start --mode local/gateway, stop/status/logs)

**Cambios:**
- Actualizado `cli/src/lib/config.ts`:
  - Nuevo tipo `CodeckMode = 'local' | 'gateway'` exportado
  - Campo `mode` agregado a `CodeckConfig` interface y schema (default: `'local'`)
  - `getConfig()` ahora retorna `mode`
- Actualizado `cli/src/lib/docker.ts`:
  - `ComposeOpts` acepta campo `mode?: CodeckMode`
  - `composeFiles()` selecciona `docker-compose.gateway.yml` cuando mode es `'gateway'`; en gateway mode no se aplican overlays dev/LAN
  - Import de `CodeckMode` desde config
- Actualizado `cli/src/lib/detect.ts`:
  - `getContainerStatus()` acepta parámetro opcional `mode` y usa el compose file correcto para `docker compose ps`
- Actualizado `cli/src/commands/init.ts`:
  - Nuevo prompt de modo Codeck (local vs gateway) después de verificación Docker (paso 2.5)
  - Puerto default cambia según modo: 80 (local) vs 8080 (gateway)
  - Extra ports y LAN mode se omiten en gateway mode (runtime aislado)
  - Env var generada es `CODECK_DAEMON_PORT` en gateway, `CODECK_PORT` en local
  - `setConfig()` incluye `mode`, `composeUp()` recibe `mode`
- Actualizado `cli/src/commands/start.ts`:
  - Nueva opción `--mode <mode>` (overrides config)
  - Validación de valores: solo acepta `'local'` o `'gateway'`
  - Muestra modo activo en output; en gateway mode: build siempre habilitado, dev deshabilitado
- Actualizado `cli/src/commands/stop.ts`: pasa `mode` a `composeDown()`
- Actualizado `cli/src/commands/restart.ts`: pasa `mode` a `composeDown()`, `composeUp()`, y `getContainerStatus()`; muestra modo activo
- Actualizado `cli/src/commands/status.ts`: muestra `mode` en config summary; solo muestra extra ports y LAN en local mode; pasa `mode` a `getContainerStatus()`
- Actualizado `cli/src/commands/logs.ts`: pasa `mode` a `composeLogs()`

**Problemas:** Ninguno.

**Decisiones:**
- El CLI vive en `cli/` (no en `apps/cli/`) — no se migró porque el CLI es un paquete independiente con su propio `package.json` y `node_modules`. El placeholder `apps/cli/package.json` queda como está
- Gateway mode en `composeFiles()` no aplica overlays dev ni LAN — el gateway compose file es autosuficiente con su propia red y configuración
- En gateway mode, el init skip las preguntas de extra ports y LAN mode — el runtime no tiene puertos expuestos y la red es privada
- `start --mode` permite override temporal del modo configurado — útil para testing sin re-ejecutar init
- En gateway mode, `composeUp` siempre usa `--build` porque el compose file define ambos servicios y necesita la imagen
- `getContainerStatus()` usa `-f` explícito para el compose file según modo — sin esto, `docker compose ps` buscaría el compose file default y podría mostrar containers incorrectos
- El campo `mode` tiene default `'local'` en el schema de Conf — backward compatible con configuraciones existentes que no tienen el campo

**Smoke test:**
- `npm run build` — OK (frontend vite → apps/web/dist + backend tsc → apps/runtime/dist + daemon tsc → apps/daemon/dist)
- `cd cli && npx tsc --noEmit` — OK (0 errors)
- `cd cli && npm run build` — OK (tsc → cli/dist)
- Runtime startup (port 9999) — OK, startup/shutdown limpio

---

(El agente debe agregar nuevas entradas por cada iteración)
