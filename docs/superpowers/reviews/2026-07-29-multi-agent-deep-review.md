# Review: Workflow Control Plane (workflows con Pi)

**Fecha:** 2026-07-29 · **Método:** 13 agentes (6 lectores de subsistemas, 4 de research, 3 críticos adversariales que verificaron cada hallazgo leyendo el código). Todo hallazgo citado incluye `archivo:línea` verificado.

---

## 1. Cómo está implementado

El repo es un **control plane determinista** (~14k líneas en `src/workflow`, 47 módulos, cero dependencias de runtime, ESM + inyección de dependencias) que despacha workers de coding (Pi, Claude Code, Codex, OpenCode fixture-only) a worktrees git aislados dentro de workspaces Herdr.

**Flujo principal:** `plan` (checkpoint read-only) → `start` (worktree + workspace) → `launch --dry-run` (preview + approval digest sha256) → `launch --approval-digest --yes` (recomputa el preview y falla "stale" ante cualquier drift) → worker con `assignment.md` generado → `handoff` (handoff-input.json → result.json canónico) → `result` / `reconcile` / `resume` / `close`.

**Piezas clave:**

- **Máquina de estados neutral** (`lifecycle.js` + `run-state.js`): 11 estados en tabla de transiciones congelada; las decisiones se toman *adentro* del lock (updater callbacks), escrituras atómicas temp+fsync+rename, mutex por run vía `mkdir run.lock/active` fail-fast.
- **Dos lanes:** workers externos producen resultados **canónicos**; delegaciones Pi internas (~3.8k líneas en 11 módulos) producen evidencia **advisory** que jamás puede cerrar un run — separación por construcción, no por convención.
- **Integración por harness:** Pi vía extensiones TS in-process (`.pi/extensions/`), Claude vía `--settings` generado por run, Codex vía merge aditivo en `~/.codex/hooks.json`. Los tres alimentan la misma máquina de estados. Claude y Codex comparten `hooks/lib/lifecycle-hook-core.mjs`; Pi tiene una **implementación paralela** (ver debilidades).
- **Aislamiento del prompt:** el request del usuario viaja solo como bytes de `--prompt-file`, cercado en assignment.md entre marcadores sha256 anti-colisión etiquetados como untrusted; el argv lleva solo una frase fija de bootstrap.
- **Observabilidad:** bus global `events.jsonl` (best-effort) + log de eventos por run (autoritativo, con lock) + telemetría fail-closed con versiones de harness pinneadas; watchers de 5s en el coordinador Pi; notifier detached opt-in.
- **Tests:** 662 tests en 64 archivos, ~12s, herméticos, tres niveles (fakes con semántica real → fixtures con git real → canary Pi real con confirmación tipeada). Las propiedades de seguridad (digest staleness, preservación byte-a-byte del prompt, no-mutación-antes-de-fallo, redacción de secretos) se testean como comportamiento de primera clase.

---

## 2. Fortalezas — dónde estás *adelante* del estado del arte

El survey de ~15 herramientas comparables (claude-squad, vibe-kanban, container-use, Conductor, Sculptor, cmux, Crystal, cyrus, etc.) concluyó algo contundente: **nada en el ecosistema replica tu stack de gobernanza**:

1. **Approval digest genuinamente vinculante y TOCTOU-safe** — cubre argv exacto, bytes del assignment (incluido el prompt crudo), estado reconciliado del entorno y stateRoot; se recomputa al ejecutar (`launch.js:196-351,581-597`). Ningún competidor tiene esto.
2. **Postura de identidad exacta** — pid+startedAt+cwd para delegaciones; paneId+session+cwd vía Herdr para interactivos; jamás scraping de terminal ni sesiones adivinadas. oh-my-pi llegó independientemente a la misma regla (`persisted-revive.ts` rehúsa revivir sin contrato persistido) — validación externa fuerte.
3. **El modelo de dos lanes** — omp convergió en lo mismo desde la dirección opuesta (task lane canónica con yields validados por schema vs advisor advisory). Es la arquitectura correcta.
4. **Disciplina de concurrencia consciente** — decide-inside-the-lock con rationale documentado, patch vacío `{}` para no-ops, identidad de transporte persistida primero por una carrera observada en vivo y comentada (`launch.js:722-732`).
5. **Suite de tests inusualmente buena** — fakes que preservan semántica real (el fake store rutea por el `transitionRun` real), probes de secretos en cada error path, canary con guardas testeadas.
6. **Superficie de prompts ya magra** — AGENTS.md de 59 líneas, prompts de 20 líneas, skill con tabla de errores comunes. Ya estás cerca de lo que pide el artículo de Claude 5.

El artículo de context engineering y el post de building-effective-agents **validan directamente** tus decisiones núcleo: checkpoints humanos deterministas, subagentes que devuelven resúmenes condensados (result.json, no transcripts), estado fuera de la ventana de contexto (events.jsonl), tool design poka-yoke (env vars `WORKFLOW_*`, handoff por schema).

---

## 3. Puntos débiles — verificados en código, por severidad

### 🔴 Alta (pueden trabar runs, perder resultados o matar al coordinador)

**D1. Las reservas de delegación nunca se liberan — ni en el happy path.**
`reservations.release()` existe pero tiene **cero llamadores** en todo el repo; no hay subcomando CLI. Cada delegación deja un lease `active` que cuenta contra la capacidad para siempre: con `writersPerCheckout=1`, **una sola** delegación writer exitosa brickea el lane writer del checkout; con `totalInternal=4`, cuatro delegaciones cualesquiera agotan el lane interno del proyecto. Los failure paths devuelven nextAction `manual-release-reservation`… que ningún comando implementa. (`delegation-services.js:397-462`, `delegation-reservations.js:278-297`, `bin/workflow.js:59-62`)

**D2. Un run dir sin run.json envenena todo, y los watchers lo convierten en crash.**
`list()` deja propagar el throw de `readRunInternal` por entrada (`run-store.js:711-721`); `create()` hace mkdir antes de escribir run.json (`:619-632`), así que un crash en esa ventana —que la política no-cleanup preserva para siempre— rompe `list()` para *todos* los runs. El delegation-store y ambos watchers de 5s van por ahí, y los watchers encadenan `.finally()` **sin `.catch()`** (`worker-watcher.js:74-76`, `delegation-watcher.js:104-106`): cada poll produce un unhandled rejection que por política default de Node **termina el proceso host del coordinador Pi**. Un launch crasheado puede tumbar listing, contabilidad de delegaciones y entrega de resultados.

**D3. El delegation watcher puede consumir un resultado y perderlo.**
Solo `consumeResult` está en try/catch; si la entrega (`deliverResult` → `pi.sendMessage`) lanza después, el registro queda marcado consumido para siempre y `currentTerminalResult()` no lo vuelve a mostrar — el resultado advisory se pierde para la sesión origen (sobrevive solo como archivo). (`delegation-watcher.js:128-140`)

**D4. El write final del launcher puede regresar COMPLETED→RUNNING o marcar FAILED a un worker vivo.**
La identidad de transporte se endureció contra la carrera, pero el write de estado siguiente es un patch fijo que ignora el estado actual (`launch.js:734-743` vía `updateRun` en `:549-551`), y COMPLETED→RUNNING es transición legal (`run-state.js:41`). Un worker rápido que completa dentro de la ventana de launch regresa silenciosamente a RUNNING sin evento posterior que lo corrija.

**D5. El protocolo de lifecycle está implementado dos veces y ya divergió.**
Pi usa flags en memoria (`workflow-worker-lifecycle.ts`); Claude/Codex usan markers persistidos (`lifecycle-hook-core.mjs`). `continuationPrompt()` y `handoffExists()` están copy-pasteados. La divergencia es *observable*: tras un `resume`, Pi arranca con flags frescos y reusa la generación, mientras Claude/Codex leen el marker persistido y la incrementan — la misma acción da aritmética de generación distinta por harness, y la generación es la llave que valida handoffs y staleness de stops.

**D6. Resume reconstruye el argv a mano y cambia el sobre de seguridad aprobado.**
`relaunchSession` (`commands.js:1281-1320`) omite `--permission-mode`/`--model` en Claude y `--sandbox` en Codex (hardcodea `-a never`). Un worker resumido corre bajo permisos distintos a los que el approval digest aprobó — en el camino de recovery, donde nadie re-revisa. Además `resume --yes` tiene ventana observe→relaunch sin lock: dos invocaciones concurrentes doble-relanzan en el mismo worktree (`resume.js:25-50`).

**D7. Los mutex fail-closed no tienen ningún affordance de recovery.**
Lock de run stale: se reporta, jamás se limpia, y no existe `workflow unlock` — todo update de ese run lanza hasta que hagas `rmdir` a mano de un directorio oculto 0700. El gate de reservas ni siquiera tiene datos de liveness en `owner.json` (solo un token: no pid, no timestamp), así que tras un crash **todo** reserve/release del proyecto falla. Los specs prometen comandos de inspección/limpieza que nunca se construyeron. (`run-store.js:343-358`, `delegation-reservations.js:168-180`)

**D8. `verify` del registry es wiring muerto: cada launch real manda comandos de verificación equivocados.**
`registry.js` valida `verify` pero nadie lo consume; no hay flag CLI ni camino que setee `verificationCommands`, así que el fallback hardcodeado siempre dispara — y referencia los tests *de este repo* (`node --test test/workflow-launch.test.js`, `npm test`), incorrectos para todo otro proyecto. Cada worker despachado recibe guía de verificación activamente engañosa. (`registry.js:264-266`, `assignment.js:176-180`)

### 🟡 Media (fricción real / deuda)

- **D9. Codex hooks.json:** el merge "aditivo" puede clobberear hooks de terceros (JSON transitoriamente inválido → catch → `{hooks:{}}` → writeFile total, sin temp+rename), y la idempotencia por string exacto de comando duplica hooks tras mover el repo — inflando generaciones. (`codex-hooks.js:66-79,40-47`)
- **D10. Un profile Claude puede pisar el `--settings` aprobado:** `FORBIDDEN_ARGUMENTS` no incluye `--settings`/`--mcp-config`/`--append-system-prompt`/`--session-id`/`--resume`, y los arguments del profile van *después* del `--settings` generado (last-wins). (`registry.js:32-39`, `harnesses.js:160-164`)
- **D11. Resultados de delegación gen-1 son falsificables** por cualquier proceso del mismo usuario (el claim token solo protege remediaciones); un child con bash puede enviar un veredicto forjado por un sibling. La maquinaria del fix ya existe. (`delegation-handoff.js:120-132`, `delegation-store.js:361-367`)
- **D12. Pipeline de notificaciones con 4 defectos compuestos:** estados con guion bajo muertos en `TERMINAL_RUN_STATES` (`needs_input` vs `needs-input` — nunca matchean), dedupe por runId para siempre (un run que paró y luego completa no re-notifica; el delegation watcher lo hace bien con generación), cursor que salta líneas cortadas para siempre, y `WORKFLOW_HANDOFF_NOTIFIER` ignorado justo en el path de handoff (el env override reemplaza `process.env` entero). (`worker-watcher.js:3,106-108`, `events-bus.js:47-58`, `handoff.js:539`)
- **D13. `launch --format json` post-execute emite JSON inválido** entre 12k y ~77.5k chars (el emit usa el límite default en vez de `LAUNCH_OUTPUT_LIMIT` como los previews). (`bin/workflow.js:39,701`)
- **D14. `reconcile` reporta un `git status` que falla como "clean"** — alimenta clasificación optimista al flujo de aprobación justo cuando el checkout está más sospechoso. (`reconcile.js:65-71`)
- **D15. Errores tragados universalmente sin canal de diagnóstico:** correcto para "nunca romper al worker", pero un upgrade de harness que cambie payloads degrada invisible (generaciones congeladas, runs pegados en RUNNING, telemetría en "unknown") sin que nada registre por qué. El pin de versiones ya driftió *dentro del repo*: telemetría pinnea codex 0.144.3, el spec del lane Codex verifica contra 0.145.0.
- **D16. Escala O(historia total):** events.jsonl sin rotación; los watchers escanean todo el state root cada 5s por sesión. Bien a decenas de runs, treadmill oculto a cientos.
- **D17. Validación de delegación duplicada en 3-5 capas que ya divergen:** `coordinator-policy.js` tiene la variante más débil (no compara checkoutDigest). Defense-in-depth debería ser el mismo predicado evaluado N veces, no N aproximaciones a mano.
- **D18. Calidad:** sin CI para 662 tests en repo recién publicado; los lanes Claude/Codex no tienen ningún camino e2e (el fixture bypasea la ingesta por hooks — un settings generado roto pasa toda la suite); el smoke de Herdr vivo es un placeholder que lanza; `engines >=20` es falso para correr los tests (imports .ts requieren ≥22.18); `run.json` estampa `version: 1` que nadie chequea jamás.

---

## 4. Qué mejorar — priorizado

### Quick wins (líneas, no días — la mayoría son fixes de los bugs de arriba)

1. `.catch()` en ambos schedule de watchers; entregar-antes-de-consumir (o flag redeliverable) en el delegation watcher. *(D2/D3)*
2. Skip por entrada con warning en `list()` — preserva no-cleanup, acota el blast radius a un run. *(D2)*
3. Liberar la reserva dentro de `recordResult` + comando `workflow delegation release`. *(D1)*
4. Guard de estado en el write final del launcher (el updater ya recibe el estado bajo lock; es un `if`, no maquinaria nueva). *(D4)*
5. Cablear `project.verify` → assignment y borrar el fallback hardcodeado. *(D8)*
6. `{limit: LAUNCH_OUTPUT_LIMIT}` en el emit del execute report. *(D13)*
7. Estados con guion en `TERMINAL_RUN_STATES`; dedupe por (runId, generation); cursor hasta el último newline; spread de `process.env` en notifyHandoff. *(D12)*
8. Extender `RAW_CONTROL_ARGUMENTS` de Claude con `--settings`, `--mcp-config`, `--append-system-prompt`, `--session-id`, `--resume`. *(D10)*
9. `safeStatus` → `{dirty: null, error}` y tratar unknown como conflicto. *(D14)*
10. GitHub Actions con `npm test` (y corregir `engines`). *(D18)*
11. Log de debug best-effort `hooks-debug.log` en el run dir dentro de los catch + `workflow doctor` mostrando versiones de harness vs pins. *(D15)*
12. Requerir el claim token en toda generación, no solo remediaciones. *(D11)*

### Mediano plazo (features con leverage real)

1. **`workflow runs`** — board read-only cross-proyecto (id, estado, ticket, harness, worktree, updatedAt). Hoy no podés responder "¿qué está corriendo, qué necesita input, qué completó sin mergear?" — es table stakes en todo el ecosistema. Y **`workflow inbox`**: runs bloqueados en permisos (Herdr ya sabe el estado blocked).
2. **`workflow verify <run-id>`** — re-ejecutar los comandos verify del proyecto en el worktree exacto grabado, evidencia estructurada en events.jsonl. Hoy "verification: passed" es autorreporte del worker: confianza, no evidencia. Luego un critic advisory (delegación Pi que revisa el diff contra assignment.md) — encaja exacto en la semántica de dos lanes.
3. **`workflow merge <run-id> --dry-run` → `--approval-digest`** y **`workflow archive`** — el arco entra gobernado y sale por git manual sin gobierno. La misma gramática de digest que ya tenés, aplicada a la salida. (cmux/container-use/Conductor tienen todos su verbo de landing.)
4. **Recovery real:** owner markers `{pid, startToken, runId}` (patrón de omp `isolation-ownership.ts` — startToken = tiempo de arranque del proceso, inmune a pid reciclado) + `workflow unlock` guiado que *prueba* muerto al dueño antes de limpiar. Mantiene no-cleanup por default, hace real la recuperación manual prometida.
5. **Unificar el lifecycle:** la extensión Pi como adapter delgado sobre `lifecycle-hook-core` (los markers persistidos también arreglan la divergencia post-resume). Un solo módulo dueño del protocolo. *(D5)*
6. **Persistir el profile resuelto en el run record** y darle a `buildHarnessLaunch` una variante resume — mata D6 de raíz.
7. **Sandboxing opcional:** `sandbox: bwrap` por profile que prefija el argv (bubblewrap/sandbox-runtime de Anthropic: worktree+run dir escribibles, home enmascarado, política de red explícita). Como el argv ya es shell-free y entra al digest, el sandbox queda **cubierto por la aprobación gratis**. Hoy Pi y Claude corren con todos tus privilegios; el worktree es frontera git, no de seguridad.
8. **Presupuestos:** la telemetría Pi ya captura tokens/costo y nadie lo lee. Techo por proyecto/launch en projects.yaml, chequeado en hooks (que ya corren por prompt/stop) → evento `budget-exceeded`. Con modelos clase Fable corriendo días, esto pasa de nice-to-have a necesario. Bonus: el statusline de Claude ya recibe cost/tokens por stdin y los tira — son ~20 líneas capturarlos.
9. **Fan-out:** `workflow launch --agent pi-worker,claude-worker,codex-worker` — N runs de un digest. La maquinaria de aislamiento ya hace seguros los siblings; solo falta la ergonomía. El bake-off cross-harness es el payoff único de tu apuesta multi-harness que ningún competidor puede ofrecer (Crystal construyó un producto entero sobre fan-out mono-harness).
10. **`herdr pane report-agent` con runId como metadata** desde los tres hooks — correlación pane↔run positiva, retira el carve-out `trustPaneWhenSessionUnreported` de Codex (el único lugar donde "no guessed sessions" se dobla).

---

## 5. Prácticas modernas de agentes aplicables

### Del artículo de Claude 5 (context engineering)

El titular: Anthropic borró **>80% del system prompt de Claude Code** para Opus 5/Fable 5 sin pérdida medible. Los seis shifts, aplicados a tu repo:

| Regla | Aplicación acá |
|---|---|
| Reglas → criterio | Las "Operating rules" de AGENTS.md y las Safety Prohibitions del assignment pueden comprimirse a principios + los invariantes duros (secretos, producción, prompt-file-only) que el artículo explícitamente exceptúa. |
| Ejemplos → interfaces | Ya lo hacés (handoff por schema, env vars, CLI). Invertir en expresividad del schema, no en prosa. |
| Todo upfront → progressive disclosure | El assignment inlinea todo. Agregar una sección **References** con paths (plan aprobado en el run dir, spec de docs/superpowers/specs, tests del proyecto como rúbricas ejecutables) y adelgazar el resto. |
| Repetición → tool descriptions | El procedimiento de handoff aparece en assignment, AGENTS.md y hooks; consolidarlo en el `--help` del CLI y los errores del schema. |
| Memoria manual en CLAUDE.md → auto-memory | No acumular notas de estado en CLAUDE.md de worktrees; el registro canónico ya es el run store. |
| Specs simples → referencias ricas | Código > prosa: apuntar al spec y a los tests reales en vez de parafrasearlos. |

Acción de costo cero: correr `/doctor` sobre este repo y sobre worktrees representativos.

### De oh-my-pi (lo más robable, concreto)

- **Ownership markers pid+startToken** (`isolation-ownership.ts`) — ya citado en mejoras #4. La pieza que gradúa no-cleanup a garbage collection *demostrablemente* segura.
- **Contrato `session_init` persistido + revival que rehúsa adivinar** — valida tu postura; adoptable: persistir el contrato completo del worker (harness, hash del prompt, política de tools, schema) como primer registro del run y que `resume` lo verifique.
- **JSONL con header versionado + migraciones + parsing leniente + lecturas prefix/tail acotadas** — resuelve D18 (version write-only), la fragilidad a líneas corruptas, y el listing O(bytes).
- **Metaharness:** índice SQLite descartable sobre filesystem-como-fuente-de-verdad, y resume que recupera los flags originales de un snapshot — extendé el digest a replay.
- **Taxonomía de errores preflight/isolation/execution** — en events.jsonl distingue "rechazado sin efectos" de "falló materializando el worktree" de "el worker corrió y falló"; esa distinción decide si el no-cleanup aplica siquiera.
- **IrcBus: receipts con outcome (`injected|woken|revived|failed`) y never-block** — la versión madura de tus notificaciones de coordinador (commit 367433b).
- **Advisor con severidad `aside|concern|blocker`** y el doer obligado a corregir o justificar — upgrade barato al protocolo de evidencia advisory.
- **mnemopi:** banco de memoria por repo consolidado desde runs completados (gotchas de harness, pitfalls del repo) inyectado con tope de tokens y redacción de secretos; y su patrón **lease+heartbeat** para procesos background concurrentes — exactamente tu topología.
- Sus docs de extensiones son además el mejor argumento *a favor* de tu diseño cross-proceso: un hook in-process que lanza tumba la sesión entera.

### Del ecosistema 2025–2026

- **Claude Code agent teams** (experimental): coordinación por archivos + task list compartida + hooks `TaskCreated/TaskCompleted/TeammateIdle` que vetan con exit 2 — tu settings generado puede registrarlos hoy para gobernar teams dentro de un worker Claude (teammates = advisory, jamás canónico). Ojo: los teams heredan `--dangerously-skip-permissions` del lead — el preview debería gatearlo.
- **Checkpoint git pre-launch:** ref `refs/workflow/<run-id>/pre-launch` antes de arrancar el worker — rewind que sí captura efectos de bash (a diferencia del checkpointing de Claude Code), aditivo, base de diff exacta para status/reconcile.
- **Pi upstream** ya trae **modo RPC** (JSONL por stdin/stdout) — encaja exacto con tu postura no-scraping y da identidad de sesión exacta gratis; session trees con `/fork` para el recovery lane; y un sistema de paquetes (`pi install git:`) para versionar tus extensiones en vez de copiarlas. **Codex 0.145+**: thread IDs persistidos con nombre (resume estricto por ID) y forking read-only para inspección post-hoc.
- **Verificación híbrida como norma:** checks deterministas re-ejecutados sobre el 100% de outputs + critic adversarial antes de la revisión humana → mejoras #2.
- **Plan-approval mode:** hoy aprobás el *prompt*; el patrón 2026 aprueba también el *plan del agente* — worker arranca read-only, emite un plan al run dir, segunda aprobación con digest sobre ese plan. Extiende tu filosofía de checkpoint del intent del operador al intent del agente.
- **Durable execution (disciplinas Temporal, sin daemon):** replay testing (`reconcile --replay` reconstruye estado solo desde events.jsonl y asserta equivalencia con run.json), claves de idempotencia en pasos mutantes, y eventos de compensación ("requiere recovery manual: X") que reconcile pueda enumerar.
- **OTel GenAI semconv:** mapear tu vocabulario de telemetría a `gen_ai.*` + `workflow telemetry export --format otlp-json` — transformación pura de archivos, importable en cualquier backend.
- **MCP 2026-07-28** (core stateless + Tasks): un `workflow mcp` read-only por stdio (doctor/plan/status/result/reconcile como tools tipadas, mutaciones NO expuestas) — los coordinadores consultan estado sin parsear texto de CLI, el digest sigue en manos humanas.
- **Fable 5 / runs de días:** convención de heartbeat (hooks apéndean liveness periódico a events.jsonl) para distinguir un run de tres días de uno muerto — sin scraping; refuerza la necesidad de budgets.

---

## 6. Veredicto

**El lado de entrada (plan→digest→launch) es tu moat** — más formal que todo lo surveyado; no lo compliques más. Las inversiones con mejor retorno, en orden:

1. **Confiabilidad de la fontanería** (D1–D4, D12): son fallas *silenciosas* en el camino crítico de notificaciones y estado; casi todas se arreglan en líneas.
2. **El lado de salida** (runs/verify/merge/archive/inbox): es donde cada competidor te supera y donde tu gramática de digest se reusa tal cual.
3. **Unificación** (lifecycle core único, invariantes de delegación compartidos, argv builders para resume): la duplicación ya divergió tres veces de forma medible; con harnesses evolucionando mensualmente, es tu mayor riesgo externo.
4. **Contexto/assignment** según Claude 5: recortar prohibiciones, sumar References, cablear verify — barato y mejora cada run.
