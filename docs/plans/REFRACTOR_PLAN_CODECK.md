# Codeck Refactor Plan — Monorepo + Daemon/Runtime (Gateway Mode)

Este documento define el plan completo de refactorización.
Es la fuente de verdad técnica.

El agente debe:
- Leer este archivo en cada iteración.
- Ejecutar SOLO un bloque de tareas por corrida.
- Marcar los checkboxes completados.
- Registrar decisiones en REFRACTOR_LOG.md.
- Trabajar únicamente en la rama de refactor.

---

# MODOS SOPORTADOS

## local
- Todo corre en un contenedor.
- Runtime sirve la webapp.
- Browser → runtime directamente.

## gateway
- nginx → daemon:8080
- daemon → runtime (docker network privada)
- runtime NO está expuesto.
- browser nunca habla con runtime.

---

# DECISIONES CERRADAS

- Modo público se llama: `gateway`
- daemon puerto: 8080
- runtime internal HTTP: 7777
- runtime internal WS: 7778
- docker network: codeck_net
- runtime container name: codeck-runtime
- frontend SIEMPRE usa rutas relativas `/api`
- NO docker services (postgres etc)
- NO host.exec
- Rate limit en daemon
- Sesiones múltiples por dispositivo
- Auditoría por eventos

---

# ESTRUCTURA MONOREPO TARGET

apps/
  web/
  daemon/
  runtime/
  cli/

packages/
  shared/
  protocols/

container/
docs/
scripts/

---

# CURRENT NEXT BLOCK

- [x] MILESTONE 0 — PREPARACIÓN (completado)
- [x] MILESTONE 1 — WEBAPP (completado)
- [ ] MILESTONE 2 — RUNTIME (en progreso: 2.1 completado, siguiente: 2.2)

---

# MILESTONE 0 — PREPARACIÓN

- [x] Crear rama refactor/daemon-runtime-gateway
- [x] Crear estructura monorepo (apps/, packages/)
- [x] Agregar turbo.json
- [x] Configurar workspaces
- [x] Crear packages/shared
- [x] Crear packages/protocols
- [x] Crear REFRACTOR_LOG.md

DONE cuando:
- El repo compila como monorepo vacío.

---

# MILESTONE 1 — WEBAPP

- [x] Mover SPA a apps/web
- [x] Configurar build output apps/web/dist
- [x] Eliminar hardcodes de host
- [x] Usar API_BASE=/api relativo

DONE cuando:
- Web build funciona aislado.

---

# MILESTONE 2 — RUNTIME

## 2.1 Server base
- [x] Crear apps/runtime
- [x] Implementar /internal/status
- [x] Servir web en modo local

## 2.2 PTY
- [ ] Migrar node-pty
- [ ] WS /internal/pty/:id
- [ ] Limitar sesiones concurrentes

## 2.3 Filesystem
- [ ] read/write/list/delete/rename

## 2.4 Proactive Agents
- [ ] CRUD
- [ ] Scheduler
- [ ] Eventos create/update/delete/run

## 2.5 Memory/Index
- [ ] Migrar implementación existente

DONE cuando:
- local mode funciona igual que el sistema actual.

---

# MILESTONE 3 — DAEMON

## 3.1 Server base
- [ ] apps/daemon en :8080
- [ ] Servir web estática
- [ ] /api/ui/status

## 3.2 Auth + sesiones
- [ ] login/logout
- [ ] listar sesiones
- [ ] revoke session
- [ ] deviceId estable
- [ ] lastSeen update

## 3.3 Auditoría
- [ ] audit.log JSONL
- [ ] eventos auth

## 3.4 Rate limit
- [ ] auth agresivo
- [ ] writes moderado
- [ ] configurable por env

## 3.5 Proxy HTTP
- [ ] /api/runtime/* → runtime internal

## 3.6 Proxy WS
- [ ] Browser WS → daemon → runtime
- [ ] límite conexiones
- [ ] heartbeat

DONE cuando:
- gateway mode funciona con runtime privado.

---

# MILESTONE 4 — NETWORKING

- [ ] Crear docker network codeck_net
- [ ] runtime container name codeck-runtime
- [ ] runtime puertos 7777/7778 internos
- [ ] daemon conecta por nombre contenedor

DONE cuando:
- nginx → daemon → runtime funciona.

---

# MILESTONE 5 — CLI

- [ ] codeck init
- [ ] codeck start --mode local
- [ ] codeck start --mode gateway
- [ ] stop/status/logs

DONE cuando:
- Ambos modos arrancan desde CLI.

---

# EVENTOS DE AUDITORÍA

Registrar:

auth.login
auth.logout
auth.session_revoked
pty.open
pty.close
files.write
files.delete
files.rename
proactive.create
proactive.update
proactive.delete
proactive.run_start
proactive.run_end
runtime.restart

Cada evento debe incluir:
timestamp
sessionId
deviceId
actor
metadata
