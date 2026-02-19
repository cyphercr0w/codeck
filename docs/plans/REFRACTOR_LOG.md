# Refactor Log — Codeck

Este archivo registra el progreso y decisiones técnicas.

---

## Estado actual

Branch: refactor/daemon-runtime-gateway
Modo objetivo: local + gateway
Último bloque completado: MILESTONE 1 — WEBAPP

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

(El agente debe agregar nuevas entradas por cada iteración)
