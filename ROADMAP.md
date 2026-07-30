# Control Plane Hardening Roadmap

**Creado:** 2026-07-29 · **Fuente:** review multi-agente profunda — evidencia completa con `archivo:línea` en [`docs/superpowers/reviews/2026-07-29-multi-agent-deep-review.md`](docs/superpowers/reviews/2026-07-29-multi-agent-deep-review.md). Los IDs `D1`–`D18` referencian los hallazgos de esa review.

**Cómo usar este documento:** cada ítem es una unidad de trabajo pequeña (idealmente un commit/PR). Marcá el checkbox al completar y anotá el commit al lado (`- [x] 0.1 … (abc1234)`). Los ítems de Fase 0 son fixes directos: no necesitan diseño previo, sí tests. Los de Fases 1–4 no triviales siguen el flujo normal del repo (brainstorm → spec en `docs/superpowers/specs/` → plan en `docs/superpowers/plans/` → implementación). Dentro de cada batch el orden es el recomendado; entre batches no hay dependencia salvo que se indique.

---

## Fase 0 — Confiabilidad: quick wins (fixes de líneas, no de días)

Son las fallas *silenciosas* en el camino crítico de estado y notificaciones. Prioridad máxima.

### Batch A — Watchers y pipeline de notificaciones (D2, D3, D12)

- [x] **0.1** Agregar `.catch()` a los schedule de ambos watchers (`worker-watcher.js:74-76`, `delegation-watcher.js:104-106`): registrar el error de forma acotada y seguir polleando. Hoy cualquier error de poll es un unhandled rejection que puede matar el proceso host del coordinador Pi. *(9eebba2)*
- [x] **0.2** Delegation watcher: entregar antes de consumir, o marcar `delivery-failed` redeliverable si `deliverResult` lanza tras `consumeResult` (`delegation-watcher.js:128-140`). Hoy un fallo de entrega pierde el resultado advisory para siempre. *(9eebba2)*
- [x] **0.3** `run-store.list()`: skip por entrada con warning acotado en vez de propagar el throw (`run-store.js:711-721`). Un run dir sin `run.json` (ventana de crash en `create()`, `:619-632`) hoy envenena el listing de todos los runs y cascadea a los watchers. Mantener `read()`/`update()` estrictos. *(9eebba2)*
- [x] **0.4** Corregir `TERMINAL_RUN_STATES` en `worker-watcher.js:3`: usa `needs_input`/`manual_handoff_required` con guion bajo pero los estados reales llevan guion (`run-state.js:8,13`) — esas notificaciones nunca matchean. *(9eebba2)*
- [x] **0.5** Dedupe del worker-watcher por `(runId, generation)` en vez de runId-para-siempre (`worker-watcher.js:106-108`), espejando el `noticeKey` del delegation watcher. Hoy un run que paró, se resumió y completó no re-notifica. *(9eebba2)*
- [x] **0.6** `events-bus.readEvents`: avanzar el cursor solo hasta el último `\n` (`events-bus.js:47-58`). Hoy una línea cortada a mitad de escritura se salta para siempre. *(9eebba2)*
- [x] **0.7** `handoff.js:539`: spread de `process.env` en el env del notifier. Hoy `WORKFLOW_HANDOFF_NOTIFIER` (y `HOME`) se ignoran justo en el path de handoff. *(9eebba2)*

### Batch B — Correctitud de la máquina de estados (D4, D6, D7)

- [x] **0.8** Write final del launcher consciente del estado: en el updater, transicionar a RUNNING solo desde PLANNED/LAUNCHING y estampar FAILED solo desde LAUNCHING; devolver `{}` si el worker ya avanzó (`launch.js:734-743`, `:549-551`). Hoy puede regresar COMPLETED→RUNNING o marcar FAILED a un worker vivo. *(ffc6929)*
- [x] **0.9** Retry acotado (3 intentos, backoff 25–100ms con jitter) en `acquireLock` solo para contención (`run-store.js:446-460`). Hoy una colisión de milisegundos entre el launcher y el hook `onStop` del worker pierde la transición COMPLETED sin diagnóstico. *(ffc6929)*
- [x] **0.10** Lock alrededor de observe→relaunch en `executeResume` (`resume.js:25-50`): re-leer el run bajo el lock, verificar que `transportIdentity` no cambió desde `planResume`, rehusar con conflicto si se movió. Hoy dos `resume --yes` concurrentes doble-relanzan al mismo worktree. *(ffc6929)*

### Batch C — Assignment, config y delegación (D1, D8, D10, D11, D13, D14)

- [x] **0.11** Cablear `project.verify` del registry → plan → `buildAssignmentTemplate` y eliminar el fallback hardcodeado (`assignment.js:176-180`; el fallback referencia los tests *de este repo*). Fallback nuevo: instrucción genérica de descubrir y correr los checks propios del proyecto. **Prerequisito de 2.3 (workflow verify).** *(006d179)*
- [x] **0.12** `bin/workflow.js:701`: pasar `{limit: LAUNCH_OUTPUT_LIMIT}` en el emit del execute report, como ya hacen los previews (`:679,:686`). Hoy reportes entre 12k y ~77.5k chars salen como JSON truncado inválido. *(006d179)*
- [x] **0.13** Extender `RAW_CONTROL_ARGUMENTS` de Claude con `--settings`, `--mcp-config`, `--append-system-prompt`, `--session-id`, `--resume` (`registry.js:32-39`). Hoy un profile puede pisar el `--settings` generado que el digest aprobó (`harnesses.js:160-164`, last-wins). *(006d179)*
- [x] **0.14** `reconcile.safeStatus`: devolver `{dirty: null, error}` y que el clasificador trate status desconocido como conflicto (`reconcile.js:65-71`). Hoy un `git status` que falla se reporta como clean y alimenta el flujo de aprobación. *(006d179)*
- [x] **0.15** Requerir claim token por delegación en **toda** generación, no solo remediaciones: mintearlo al claim, pasarlo al child solo por su env privado, exigirlo al recibir el resultado. Un child con bash podía forjar el resultado de un sibling. *(006d179)* — **implementado en `submitDelegationHandoff`** (el borde que cruza el child), no en `recordResult`: así el primitivo del store sigue usable por los llamadores internos de confianza y hay un solo punto de enforcement por caso (remediación vs generación normal).
- [x] **0.16** Reservas de delegación: liberar el lease al aterrizar un resultado terminal + comando `workflow delegation release <run-id> <delegation-id>` para el residuo de start-failures. Una sola delegación writer exitosa brickeaba el lane para siempre. *(006d179)* — **implementado con `releaseForDelegation({projectAlias, delegationId})`** en vez de `release({reservation})`: el ownerToken se mintea dentro de `reserve()` y nunca se persiste fuera del lease, así que ningún llamador posterior puede presentarlo (por eso `release()` no tenía llamadores). La autorización viene de que ambos call sites verifican contra el run store que la delegación ya no corre.

### Batch D — Calidad e infraestructura (D9, D15, D18)

- [x] **0.17** CI: GitHub Actions corriendo `npm test` en push/PR, y corregir `engines` a `>=22.18` (los tests importan `.ts` con type stripping nativo; `package.json:31` hoy declara `>=20`). *(05274f1)*
- [x] **0.18** Observabilidad de hooks: append best-effort a `hooks-debug.log` dentro del run dir en los catch blocks (acotado), y `workflow doctor` reportando versión instalada de cada harness vs `SUPPORTED_VERSIONS` (`telemetry-adapters.js:10-15` — ya driftió: pinnea codex 0.144.3, el spec del lane verifica 0.145.0). *(05274f1)*
- [x] **0.19** `codex-hooks.js`: rehusar escribir si el hooks.json existente no parsea (reportar, no clobberear con `{hooks:{}}`), escribir con temp+rename, e idempotencia por marker estable (nombre de hook) en vez de string exacto de comando con path absoluto (`codex-hooks.js:40-47,66-79`). Hoy puede destruir hooks de terceros y duplica entradas tras mover el repo. *(05274f1)*

---

## Fase 1 — Recovery y unificación (deuda estructural)

- [ ] **1.1** Owner markers `{pid, startToken, runId}` escritos al launch junto al worktree y run dir (startToken = tiempo de arranque del proceso vía `/proc/<pid>/stat` campo 22, inmune a pid reciclado — patrón de oh-my-pi `isolation-ownership.ts`). Después: `workflow unlock <run-id>` y clear del gate de reservas que **prueban** muerto al dueño antes de limpiar, y agregan pid+timestamp a `owner.json` del gate (`delegation-reservations.js:168-180` hoy no tiene datos de liveness). Hace real la recuperación manual que los specs prometen sin romper no-cleanup. *(D7)*
- [ ] **1.2** Lifecycle core único: convertir `.pi/extensions/workflow-worker-lifecycle.ts` en adapter delgado sobre `hooks/lib/lifecycle-hook-core.mjs` (markers persistidos; también corrige la divergencia de generaciones post-resume entre Pi y Claude/Codex). Un solo módulo dueño de `continuationPrompt`, `handoffExists`, discriminación de generación y condiciones de notify. *(D5)*
- [ ] **1.3** Persistir el profile resuelto (permission_mode, sandbox, approval_policy, model) en el run record al launch, agregar variante resume a `buildHarnessLaunch`, y que `relaunchSession` (`commands.js:1281-1320`) la use en vez de armar argv a mano. Exportar `CLAUDE_WORKER_SETTINGS_FILE` de un solo lugar. Hoy un resume corre con permisos distintos a los aprobados. *(D6)*
- [ ] **1.4** Módulo `delegation-invariants` compartido (lista de recursos de reserva, reservation-matches, shape de transport identity) consumido por services/handoff/reservations/coordinator-policy. Hoy hay 3–5 copias que ya divergen — `coordinator-policy.js:26-45` es la más débil (no compara checkoutDigest). *(D17)*
- [ ] **1.5** Chequear `version` de `run.json` al leer (fail-closed o migrar, como ya hace el registry v2→v3) y documentar el inventario de campos del run record en un solo lugar. Hoy `version: 1` es write-only y cada lane agrega markers ad-hoc. *(D18)*
- [ ] **1.6** E2E por harness contra fakes: fixture que ejercite la ingesta real de hooks (settings generado de Claude disparando `claude-lifecycle.mjs`, hooks.json mergeado de Codex) en vez de bypassearla con el fake agent Pi-style. Hoy un settings generado roto pasa toda la suite. Además: implementar o eliminar el smoke de Herdr placeholder (`workflow-herdr-smoke.test.js:9-12`). *(D18)*

---

## Fase 2 — Lado de salida: superficie de operador

El lado de entrada (plan→digest→launch) es el moat; acá es donde todo el ecosistema es más fuerte. La gramática de digest existente se reusa tal cual.

- [ ] **2.1** `workflow runs [--project X] [--state Y]` — board read-only cross-proyecto: id, estado, ticket, harness, worktree, updatedAt desde el state root. **Depende de 0.3** (o el board se brickea con el primer launch crasheado). Hoy no hay forma de responder "¿qué corre, qué necesita input, qué completó sin mergear?".
- [ ] **2.2** `workflow inbox` — runs bloqueados en prompts de permiso, agregados cross-proyecto (Herdr ya conoce el estado blocked por pane; events.jsonl registra transiciones).
- [ ] **2.3** `workflow verify <run-id>` — re-ejecutar los comandos verify del proyecto dentro del worktree exacto grabado, evidencia estructurada pass/fail en el event log del run, visible en `workflow result`. **Depende de 0.11.** Hoy "verification: passed" es autorreporte del worker: confianza, no evidencia.
- [ ] **2.4** `workflow merge <run-id> --dry-run` → `--approval-digest` — preview del argv exacto de merge/rebase + conflictos, ejecutar solo con digest. Cierra el último paso sin gobierno del arco. Worktree preservado post-merge (no-cleanup).
- [ ] **2.5** `workflow archive <run-id>` — cierre explícito confirmado, solo para runs terminales con dueño probado muerto/cerrado (**depende de 1.1**): remueve worktree y tab, preserva el state dir. Hoy los runs exitosos acumulan worktrees/tabs/state para siempre.
- [ ] **2.6** Critic advisory post-verify: delegación Pi (lane advisory existente, rol code-reviewer) que revisa el diff contra assignment.md; veredicto como evidencia, jamás canónico. Adoptar severidades `aside|concern|blocker` del patrón advisor de oh-my-pi.

---

## Fase 3 — Context engineering (reglas Claude 5)

Referencia: artículo "The new rules of context engineering" — Anthropic borró >80% del system prompt de Claude Code sin pérdida medible.

- [ ] **3.1** Sección **References** en `assignment.md` (`assignment.js:143-191`): paths absolutos al plan aprobado en el run dir, spec relevante de `docs/superpowers/specs/`, y comandos verify del proyecto (post-0.11). Código > prosa; el worker carga on demand.
- [ ] **3.2** Recortar Safety Prohibitions del assignment y Operating rules de AGENTS.md a los invariantes duros (untrusted request, secretos, producción, scope, un writer por checkout); reescribir el resto como principios. Los invariantes de seguridad quedan explícitos — el artículo exceptúa "highly important areas".
- [ ] **3.3** Consolidar las instrucciones de handoff en una sola fuente (help del CLI + errores del schema de handoff-input.json); eliminar la repetición entre assignment.md, AGENTS.md y hooks.
- [ ] **3.4** Correr `/doctor` sobre este repo y sobre worktrees representativos de proyectos registrados; aplicar lo que sugiera a AGENTS.md/skills.

---

## Fase 4 — Capacidades modernas (opt-in, cada una amerita spec propio)

- [ ] **4.1** Sandbox opcional por profile: `sandbox: bwrap` en projects.yaml que prefija el argv del harness (bubblewrap/sandbox-runtime: worktree + run dir escribibles, home enmascarado, política de red explícita). El argv ya es shell-free y entra al approval digest — el sandbox queda cubierto por la aprobación gratis. Hoy Pi y Claude corren con privilegios plenos del operador.
- [ ] **4.2** Presupuestos: techo de costo por proyecto/launch en projects.yaml; hooks (que ya corren por prompt/stop) comparan costo acumulado vs techo y apéndean evento `budget-exceeded`; `workflow worker status` muestra acumulado vs techo. Quick win incluido: capturar cost/tokens del payload stdin del statusline de Claude (`claude-statusline.mjs:62-66` hoy los descarta) y flippear los capability bits (`telemetry-adapters.js:4-9`). Con modelos clase Fable corriendo días, esto es necesario, no nice-to-have.
- [ ] **4.3** Fan-out: `workflow launch --agent pi-worker,claude-worker` (o `--fan-out N`) — un preview enumerando N runs con nombres sufijados, un digest cubriendo el set, N run records. La maquinaria de aislamiento ya hace seguros los siblings. Bake-off cross-harness = el payoff único del diseño multi-harness. Diseñar merge queue junto con 2.4 cuando esto exista.
- [ ] **4.4** `herdr pane report-agent` con runId como metadata desde los tres hooks (settings Claude, hooks.json Codex, extensión Pi) → correlación pane↔run positiva en session-transport/reconcile; retirar el carve-out `trustPaneWhenSessionUnreported` de Codex (`session-transport.js:44-59`), el único lugar donde "no guessed sessions" se dobla.
- [ ] **4.5** Transporte Pi por RPC upstream (JSONL stdin/stdout, `docs/rpc.md` de pi-mono) en vez de interacción por pane — framing determinista, identidad de sesión exacta gratis para resume/close. Evaluar también `/fork` de session trees para el recovery lane.
- [ ] **4.6** Checkpoint git pre-launch: ref `refs/workflow/<run-id>/pre-launch` en el worktree antes de arrancar el worker, logueado a events.jsonl. Rewind que captura efectos de bash, aditivo (no-cleanup), base de diff exacta para status/reconcile.
- [ ] **4.7** Escala del plano de observación: rotación por tamaño de events.jsonl (post-entrega de notificaciones terminales), split active/archived o índice de runs no-terminales para que los watchers no escaneen O(historia) cada 5s (`delegation-store.js:560-572`). *(D16)*
- [ ] **4.8** `workflow mcp` — servidor MCP read-only por stdio (spec 2026-07-28, core stateless): doctor/plan/status/result/reconcile como tools tipadas; mutaciones NO expuestas; muere con el cliente, sin daemon.
- [ ] **4.9** Telemetría: mapear el vocabulario a `gen_ai.*` (OTel GenAI semconv) + `workflow telemetry export <run-id> --format otlp-json`. Transformación pura de archivos.
- [ ] **4.10** Memoria por repo (patrón mnemopi): consolidar gotchas de runs completados (result.json/events.jsonl) en un banco por proyecto, inyectado en assignments futuros con tope de tokens y redacción de secretos; lease+heartbeat para consolidadores concurrentes. Contenido tratado como untrusted input.
- [ ] **4.11** Disciplinas de durable execution: `workflow reconcile --replay` que reconstruye estado solo desde events.jsonl vía lifecycle.js y asserta equivalencia con run.json; claves de idempotencia en pasos mutantes del launch; eventos de compensación enumerables por reconcile.

---

## Registro de progreso

| Fecha | Ítems | Commit(s) | Notas |
|---|---|---|---|
| 2026-07-29 | — | — | Roadmap creado a partir de la review multi-agente. |
| 2026-07-29 | 0.1–0.7 (Batch A) | `9eebba2` | Watchers y pipeline de notificaciones. Suite: 670 pass. |
| 2026-07-29 | 0.8–0.10 (Batch B) | `ffc6929` | Correctitud de la máquina de estados. Suite: 677 pass. |
| 2026-07-29 | 0.11–0.16 (Batch C) | `006d179` | Assignment/config, claim tokens y liberación de reservas. Nuevo comando `workflow delegation release`. Suite: 683 pass. |
| 2026-07-29 | 0.17–0.19 (Batch D) | `05274f1` | CI, `hooks-debug.log`, versiones de harness en doctor, merge seguro de hooks.json. Suite: 690 pass. |
| 2026-07-30 | Review adversarial de la Fase 0 | `27734d1` + fixes | 16 defectos verificados en el código nuevo, todos corregidos. Suite: 698 pass. Detalle abajo. |

**Fase 0 completa y revisada.** Rama `hardening/fase-0`, 699 tests (698 pass, 1 skip — el smoke de Herdr vivo, ítem 1.6).

### Qué encontró la review adversarial de la Fase 0

Un agente revisor verificó el diff completo ejecutando probes contra los stores reales. Encontró **1 regresión alta que introdujo el propio Batch C** y 15 defectos más, todos corregidos:

- **Regresión (la más grave):** liberar el lease en el handoff terminal, mientras `beginRemediation` seguía exigiendo un lease **activo**, mataba por completo el lane de remediación. Ningún test lo cazó porque todos los tests de remediación graban resultados con `recordResult` directo en vez de pasar por el handoff. **Corrección:** el lease ahora cubre un child **vivo** — el handoff lo libera y la remediación **re-reserva** capacidad fresca, lo que además mantiene honesto el invariante de un writer por checkout a través del hueco. Se agregó el test end-to-end handoff→remediación que faltaba.
- **El claim token no cerraba el agujero que decía cerrar:** estaba en claro en `run.json`, dentro del run dir cuyo path recibe *todo* child. El probe del revisor forjó un resultado leyéndolo. **Corrección:** se persiste solo el `sha256` (del token de delegación y también del de remediación); el secreto llega al child solo por su env privado. **Pendiente real:** un sibling del mismo uid todavía podría leer `/proc/<pid>/environ` del child vivo — el cierre completo requiere aislamiento a nivel OS (**ítem 4.1**).
- Entrega duplicada sin límite en el delegation watcher (un consume que falla siempre re-entregaba cada 5s para siempre) → ahora una entrega por generación.
- Un evento terminal solitario (`run` de SessionEnd sin handoff) se perdía si su entrega fallaba, porque el cursor de bytes ya había avanzado → cola de reintento acotada.
- El merge de `hooks.json` todavía clobbereaba hooks ajenos cuando el archivo existía pero no se podía **leer** (EACCES), y usaba un temp path fijo que dos launches concurrentes corrompían → solo ENOENT cuenta como ausente; temp único por proceso con modo 0600.
- El cap de tamaño del `hooks-debug.log` era código muerto (`stat` venía en `null`): 4000 errores producían 2 MB. Ahora se aplica de verdad.
- `onListProblem` y `onError` no tenían llamador en producción, así que un run ilegible desaparecía en silencio → cableados a stderr (CLI) y a diagnósticos acotados (coordinador).
- `CONTROL_PLANE_ARGUMENTS` solo cubría Claude: un profile de Pi podía pisar el `--session-id`/`--extension` generados → extendido a pi y codex.
- Más: `delegation release` ahora rehúsa con una remediación en vuelo; el gate de reservas reintenta una colisión viva en vez de pedir inspección manual; el claim de resume falla cerrado ante un timestamp ilegible; `doctor` ejecuta el path absoluto del harness en vez del nombre a secas; el recorder del log tolera un `env` ausente.

**Calidad de tests:** se cerraron las 3 brechas que dejaron pasar los defectos (integración handoff→remediación, re-entrega sin límite, cap del log) y se apretó un regex de 7 alternativas a las dos guardas que realmente pueden disparar.

### Pendientes conocidos (anotados, no implementados)

- **Aislamiento same-uid:** ningún secreto en el filesystem defiende contra un sibling del mismo usuario que lea `/proc/<pid>/environ`. Cierre real = **4.1** (sandbox bwrap).
- **`workflow delegation release` no tiene approval digest**, solo `--yes` — muta capacidad compartida. Considerar la gramática de digest si el comando se usa seguido.
- **`remediation.claimToken` y el claim de delegación ya usan digest**, pero la comparación vive en dos lugares (`submitDelegationHandoff` y `recordResult`). Candidato natural para el módulo de invariantes compartidos del **ítem 1.4**.

### Próximo paso sugerido

Fase 1 (recovery y unificación), empezando por **1.1** (owner markers `{pid, startToken, runId}` + `workflow unlock`), que desbloquea **2.5** (`workflow archive`).
