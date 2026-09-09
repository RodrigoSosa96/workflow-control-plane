# Critic advisory automático post-verify Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Iniciar automáticamente un critic Pi read-only y advisory después de un `workflow verify` exitoso y persistido, y exponer sus hallazgos severizados sin gatear ningún flujo canónico.

**Architecture:** Un módulo puro `post-verify-critic.js` construye el vínculo inmutable `reviewOf`, el brief y la proyección actual/stale. La infraestructura de delegación gana un origen tipado `system-post-verify` y `findings` estrictamente limitado para ese origen+rol; `verifyCommand` llama a un starter inyectable después de persistir evidencia y `resultCommand` proyecta solo el critic cuyo vínculo coincide con el último evento de verify. El transporte Pi existente conserva ownership, reserva, handoff y estados terminales.

**Tech Stack:** Node.js ESM (>= 22.18), `node:test`, zero runtime dependencies, Pi delegation transport existente.

## Global Constraints

- El critic se lanza **solo** cuando `verifyCommand` obtuvo `passed: true` y `appendEvent(type: "verification")` no devolvió `evidenceError`.
- El critic es `code-reviewer`, `background`, `concurrency: 1`, con `{maxRuntimeMs: 300000, maxTurns: 1, maxToolCalls: 24}` y `remediationTurns: 0`.
- El critic es advisory: no cambia `run.state`, el resultado canónico, `verify.passed`, exit codes de verify, merge ni archive; `blocker` es una opinión visible, no un gate.
- No crear CLI nueva, cola, watcher, retry automático, confirmación humana, dependencia o mecanismo de escritura.
- `system-post-verify` es un origen tipado sin `originSessionId`; no se entrega por el watcher a una sesión Pi. Las delegaciones interactivas existentes conservan su origen y delivery exacto.
- `findings` solo es válido para `{origin: "system-post-verify", role: "code-reviewer"}`; máximo 20, severidad `aside|concern|blocker`, textos acotados y `path` relativo sin NUL/traversal.
- La actualidad del critic se mide contra el **último evento verification persistido**, incluso si ese verify falló. Todo verify posterior vuelve stale al critic anterior; solo uno exitoso inicia uno nuevo.
- Usar TDD: cada task comienza con el test que falla y termina con su suite focalizada y commit.
- La suite completa es `WORKFLOW_PROJECTS_FILE= npm run test:ci-like`; `npm test` no es la verificación de este repo cuando esa variable está exportada.

---

## File Structure

| Archivo | Responsabilidad |
| --- | --- |
| `src/workflow/post-verify-critic.js` (nuevo) | Constantes de contrato, digest canónico `reviewOf`, builder del brief/task, selección y proyección del critic actual/stale. Sin store, transporte ni I/O. |
| `src/workflow/delegation-store.js` | Validar/persistir el origen tipado y metadata `reviewOf`; conservar `originSessionId` obligatorio solo para origen interactivo. |
| `src/workflow/delegation-handoff.js` | Validar `findings` solamente para el critic tipado antes de persistir resultado. |
| `src/workflow/delegation-services.js` | Añadir el único método sin approval humano que arranca un input system-post-verify ya construido y sigue la misma reserva/policy/transporte que `executeApproved`. |
| `src/workflow/commands.js` | Crear el critic después del evento verify persistido; leer el último evento y proyectar critic en `workflow result`. |
| `src/workflow/format.js` | Render compacto y JSON bounded de `critic`/`findings` sin perder severidad o marcador stale. |
| `bin/workflow.js` | Inyectar el starter y transporte Pi existentes para `verify`, sin exponer sintaxis nueva. |
| `.pi/agents/code-reviewer.md` | Ordenar el formato `findings` y recordar que blocker no gatea. |
| `.pi/extensions/workflow-delegation-child.ts` | Aceptar/normalizar el payload `findings` en el schema del tool; la autorización final por origen+rol queda en el handoff del servidor. |
| `README.md`, `ROADMAP.md`, `docs/run-record-fields.md` | Documentar auto-start advisory y los campos del record de delegación. |
| `test/workflow-post-verify-critic.test.js` (nuevo) | Pruebas puras del vínculo, brief y selección fresh/stale. |
| `test/workflow-delegation-store.test.js`, `test/workflow-delegation-handoff.test.js`, `test/workflow-pi-extensions.test.js` | Contratos de origen y findings en store, servidor y schema del child. |
| `test/workflow-delegation-services.test.js` | Reserva/policy/transporte del start automático y fallo advisory. |
| `test/workflow-commands.test.js`, `test/workflow-format.test.js`, `test/workflow-cli.test.js` | Integración verify/result, proyección, formatos y wiring CLI. |

---

### Task 1: Modelo puro de critic post-verify

**Files:**
- Create: `src/workflow/post-verify-critic.js`
- Test: `test/workflow-post-verify-critic.test.js`

**Interfaces:**

- Produces `POST_VERIFY_CRITIC_ORIGIN = "system-post-verify"`, `POST_VERIFY_CRITIC_ROLE = "code-reviewer"`, `POST_VERIFY_CRITIC_BUDGET` con los límites globales y `POST_VERIFY_CRITIC_REMEDIATION_TURNS = 0`.
- Produces `createReviewOf({ verification, assignmentPath, assignmentDigest, fingerprints }) -> { verificationDigest, assignmentDigest, fingerprintDigest }` donde cada digest es `sha256:` de JSON canonicalizado (keys ordenadas recursivamente).
- Produces `buildPostVerifyCriticInput({ run, verification, reviewOf, fingerprints }) -> { origin, role, mode, cwd, brief, task, budget, remediationTurns, reviewOf }`; rehúsa si falta assignment absoluto/digest, repositorio/path absoluto o fingerprint usable.
- Produces `selectPostVerifyCritic({ delegations, latestVerification }) -> record|null` y `publicPostVerifyCritic({ delegations, latestVerification }) -> object|null`; solo selecciona origen+rol exactos y marca `stale` si `reviewOf.verificationDigest` no coincide.

- [ ] **Step 1: Escribir los tests rojos del vínculo y el brief**

```js
import {
  POST_VERIFY_CRITIC_BUDGET,
  buildPostVerifyCriticInput,
  createReviewOf,
} from "../src/workflow/post-verify-critic.js";

test("buildPostVerifyCriticInput freezes assignment, verify and registered fingerprints", () => {
  const verification = { type: "verification", timestamp: "2026-08-26T12:00:00.000Z", passed: true, exitCode: 0, results: [] };
  const fingerprints = [{ repositoryId: "primary", path: "/worktrees/a", digest: "sha256:" + "a".repeat(64) }];
  const reviewOf = createReviewOf({
    verification,
    assignmentPath: "/state/run/assignment.md",
    assignmentDigest: "sha256:" + "b".repeat(64),
    fingerprints,
  });
  const input = buildPostVerifyCriticInput({
    run: { id: "11111111-1111-4111-8111-111111111111", projectAlias: "fixture", assignmentPath: "/state/run/assignment.md", assignmentDigest: "sha256:" + "b".repeat(64), repositories: [{ id: "primary", path: "/worktrees/a" }] },
    verification,
    reviewOf,
    fingerprints,
  });
  assert.equal(input.origin, "system-post-verify");
  assert.equal(input.role, "code-reviewer");
  assert.equal(input.mode, "background");
  assert.deepEqual(input.budget, POST_VERIFY_CRITIC_BUDGET);
  assert.match(input.brief, /assignment\.md/);
  assert.match(input.brief, /sha256:/);
  assert.doesNotMatch(input.brief, /stdout|stderr|secret/i);
});
```

Add cases proving canonicalization makes object key order irrelevant, a changed result/fingerprint changes `reviewOf`, and absent/relative assignment or worktree path throws.

- [ ] **Step 2: Ejecutar el test para verificar que falla**

Run: `WORKFLOW_PROJECTS_FILE= npx node --test test/workflow-post-verify-critic.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `post-verify-critic.js`.

- [ ] **Step 3: Implementar el módulo puro mínimo**

Create the module with no imports other than `node:crypto`/`node:path`. Canonicalize only plain data, hash via `createHash("sha256").update(JSON.stringify(canonical)).digest("hex")`, validate the closed origin/role/budget fields, and build a brief that names `assignmentPath`, `assignmentDigest`, verify digest, every `{repositoryId,path,fingerprint}`, the read-only constraint and the exact three severities. Never read files or call Git here.

Implement selection with this shape:

```js
export function publicPostVerifyCritic({ delegations, latestVerification }) {
  const record = selectPostVerifyCritic({ delegations, latestVerification });
  if (!record) return null;
  const fresh = record.reviewOf?.verificationDigest === verificationDigest(latestVerification);
  return {
    delegationId: record.id,
    status: fresh ? delegationStatus(record) : "stale",
    reviewOf: record.reviewOf,
    ...(record.result ? { result: publicCriticResult(record.result) } : {}),
  };
}
```

`publicCriticResult` must preserve only status, generation, summary, findings, concerns and nextAction; never return claim token, session path, task or brief.

- [ ] **Step 4: Ejecutar la suite focalizada**

Run: `WORKFLOW_PROJECTS_FILE= npx node --test test/workflow-post-verify-critic.test.js`

Expected: PASS, including fresh, stale-after-passed, stale-after-failed and non-critic exclusion cases.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/post-verify-critic.js test/workflow-post-verify-critic.test.js
git commit -m "feat: model post-verify advisory critic metadata"
```

### Task 2: Record tipado y handoff severizado

**Files:**
- Modify: `src/workflow/delegation-store.js`
- Modify: `src/workflow/delegation-handoff.js`
- Modify: `.pi/extensions/workflow-delegation-child.ts`
- Test: `test/workflow-delegation-store.test.js`
- Test: `test/workflow-delegation-handoff.test.js`
- Test: `test/workflow-pi-extensions.test.js`

**Interfaces:**

- Consumes Task 1 constants and the `reviewOf` object.
- Extends `delegations.prepare({runId,input})` input with exactly one of:
  - interactive `{originSessionId, ...}`; or
  - system `{origin: POST_VERIFY_CRITIC_ORIGIN, reviewOf, ...}`.
- Persists `origin`, `originSessionId` (`null` for system), and `reviewOf` (`null` for interactive) on every record.
- Extends an advisory result with optional `findings` only when its persisted record is the exact system critic.

- [ ] **Step 1: Escribir los tests rojos de origen**

Add store tests that prepare a system critic using Task 1’s complete input and assert:

```js
assert.equal(record.origin, "system-post-verify");
assert.equal(record.originSessionId, null);
assert.deepEqual(record.reviewOf, input.reviewOf);
```

Add negative cases: system origin with another role/mode, no `reviewOf`, an interactive input missing `originSessionId`, and an input carrying both origin shapes. Assert existing interactive fixture still stores `originSessionId` and `reviewOf: null`.

- [ ] **Step 2: Ejecutar los tests para verificar que fallan**

Run: `WORKFLOW_PROJECTS_FILE= npx node --test test/workflow-delegation-store.test.js`

Expected: FAIL because current `prepare()` rejects the `origin` and `reviewOf` keys.

- [ ] **Step 3: Implementar la discriminación de origen en el store**

Replace the flat exact-key validation with `validateDelegationInput(input)`. It must accept the shared fields plus either `originSessionId` or `{origin,reviewOf}`; reject unsupported keys and mixed shapes. Preserve the old `originSessionId` validation for interactive records. For system records, require exact constants from Task 1, role `code-reviewer`, mode `background`, budget exactly `POST_VERIFY_CRITIC_BUDGET`, remediation turns `0`, and a validated `reviewOf` with three SHA-256 digests. Persist the normalized null fields so readers never infer origin from omission.

- [ ] **Step 4: Escribir los tests rojos de `findings`**

In handoff tests, use a prepared+claimed system critic record. Submit:

```js
findings: [{
  severity: "blocker",
  summary: "Missing approval digest check",
  evidence: "commands.js:42 accepts stale state",
  path: "src/workflow/commands.js",
}]
```

Assert persistence unchanged through `delegations.recordResult`. Add rejections for `severity: "critical"`, 21 findings, extra finding keys, `/absolute`, `../escape`, `a\0b`, and an ordinary code-reviewer delegation carrying `findings`.

- [ ] **Step 5: Ejecutar para verificar el fallo**

Run:

```bash
WORKFLOW_PROJECTS_FILE= npx node --test \
  test/workflow-delegation-handoff.test.js \
  test/workflow-pi-extensions.test.js
```

Expected: FAIL because `findings` is outside `ALLOWED_KEYS` and `handoffSchema.properties`.

- [ ] **Step 6: Implementar validación punta a punta de findings**

Add the same normalized `findings` contract to `delegation-handoff.js` and `delegation-store.js`’s `validateResult`; do not trust that handoff validation is the only caller of `recordResult`. Make `findings` optional and normalize absence to `[]` only on system-critic results. Validation must use `path.relative`/`path.isAbsolute` plus segment checks so a relative path has no empty, `.` or `..` segment. Keep current concerns limits and all generic role payloads byte-for-byte compatible when `findings` is absent.

Extend `.pi/extensions/workflow-delegation-child.ts`’s `handoffSchema`, `validateHandoffInput`, byte-size payload and returned normalized value with the identical optional `findings` shape. The child cannot establish the persisted origin safely, so it validates syntax only; `submitDelegationHandoff` remains the sole boundary that rejects findings from interactive/non-critic records. Add a Pi-extension test that the registered tool accepts one valid finding and forwards it unchanged, and rejects malformed keys/severity/path before `submitHandoff` runs.

- [ ] **Step 7: Ejecutar suites focalizadas**

Run:

```bash
WORKFLOW_PROJECTS_FILE= npx node --test \
  test/workflow-delegation-store.test.js \
  test/workflow-delegation-handoff.test.js \
  test/workflow-pi-extensions.test.js
```

Expected: PASS, with existing generic handoff tests unchanged and new system-critic cases green.

- [ ] **Step 8: Actualizar inventario y commit**

Add `origin`, `originSessionId`, and `reviewOf` to the internal-shape explanation for `delegations` in `docs/run-record-fields.md`; the top-level field remains only `delegations`.

```bash
git add src/workflow/delegation-store.js src/workflow/delegation-handoff.js \
  .pi/extensions/workflow-delegation-child.ts \
  test/workflow-delegation-store.test.js test/workflow-delegation-handoff.test.js \
  test/workflow-pi-extensions.test.js docs/run-record-fields.md
git commit -m "feat: persist post-verify critic origin and findings"
```

### Task 3: Servicio de inicio automático sin aprobación humana

**Files:**
- Modify: `src/workflow/delegation-services.js`
- Test: `test/workflow-delegation-services.test.js`

**Interfaces:**

- Consumes Task 1’s already validated `buildPostVerifyCriticInput()` output and Task 2’s system record contract.
- Produces `services.startPostVerifyCritic({runId,input}) -> {state, delegationId, generation, resultStatus, nextActions, reviewOf}`.
- Uses the exact reservation, prepared request, role loading, transport identity and start-failure behavior of `executeApproved`, but consumes no human approval digest.

- [ ] **Step 1: Escribir los tests rojos del start**

Build a normal fixture with a Pi transport stub. Call:

```js
const report = await services.startPostVerifyCritic({ runId, input });
assert.equal(report.state, "running");
assert.equal(report.reviewOf.verificationDigest, input.reviewOf.verificationDigest);
assert.equal(transport.starts[0].request.agent, "code-reviewer");
assert.equal(transport.starts[0].request.async, true);
assert.equal(transport.starts[0].delegation.origin, "system-post-verify");
```

Assert the transport receives no origin session delivery target and its role tools omit `edit`, `write`, and `subagent`. Add a reservation-failure and transport-start-failure case; both must return `state: "failed"` with a persisted delegation record and not throw.

- [ ] **Step 2: Ejecutar para verificar que falla**

Run: `WORKFLOW_PROJECTS_FILE= npx node --test test/workflow-delegation-services.test.js`

Expected: FAIL because `startPostVerifyCritic` does not exist.

- [ ] **Step 3: Extraer el arranque común y añadir el método**

Refactor only the internal post-validation portion of `executeApproved` into a private helper:

```js
async function startPreparedDelegation({ fresh, skipApproval }) { /* prepare → claim → reserve → policy → transport */ }
```

`executeApproved` still validates and consumes its approval digest, then calls the helper. `startPostVerifyCritic` validates that `input` is the Task-2 system critic shape, calls `validatedPreview` through a new system-aware validation path, and calls the same helper without approval bookkeeping. It must not make `createPreview` or `executeApproved` accept automatic input accidentally.

- [ ] **Step 4: Ejecutar la suite focalizada**

Run: `WORKFLOW_PROJECTS_FILE= npx node --test test/workflow-delegation-services.test.js`

Expected: PASS. Confirm all existing preview/approval/reconciliation tests pass too.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/delegation-services.js test/workflow-delegation-services.test.js
git commit -m "feat: start post-verify critics through delegation policy"
```

### Task 4: Integrar verify/result y la presentación bounded

**Files:**
- Modify: `src/workflow/commands.js`
- Modify: `src/workflow/format.js`
- Test: `test/workflow-commands.test.js`
- Test: `test/workflow-format.test.js`

**Interfaces:**

- Consumes `createReviewOf`, `buildPostVerifyCriticInput`, `publicPostVerifyCritic` from Task 1 and `startPostVerifyCritic` from Task 3.
- `verifyCommand(options,deps)` accepts optional injected `startPostVerifyCritic({store, registry, run, input})` and `fingerprintPostVerifyCritic({cwd})` dependencies.
- Verify response gains optional `critic: {status, delegationId?, reviewOf?, reason?}`.
- Result response gains optional `critic` from `publicPostVerifyCritic`; it does not alter `status`, `exitCode`, `verifiedEvidence`, `result`, merge or archive data.

- [ ] **Step 1: Escribir los tests rojos del disparador**

In `test/workflow-commands.test.js`, extend the existing verify section with a spy starter and deterministic fingerprint reader. Assert it is called once only after a passing matrix and successful `appendEvent`, and receives the same `store`, registry, `run`, persisted verification event, assignment metadata and fingerprints. Add all three non-start cases:

```js
assert.equal(starts.length, 0); // failed matrix
assert.equal(starts.length, 0); // verify refusal
assert.equal(starts.length, 0); // appendEvent throws → evidenceError
```

For a starter that resolves `{state:"failed", nextActions:["manual-release-reservation"]}`, assert verify still returns `passed: true`, `exitCode: 0`, and bounded `critic.status === "failed"`.

- [ ] **Step 2: Ejecutar para verificar que falla**

Run: `WORKFLOW_PROJECTS_FILE= npx node --test test/workflow-commands.test.js`

Expected: FAIL because verify neither accepts nor invokes the critic dependencies.

- [ ] **Step 3: Implementar el hook post-persistencia**

Immediately after successful `appendEvent`, retain the exact event object and call a new private `startCriticAfterVerification({run,verification,deps})`. It must:

1. return `undefined` unless `verification.passed === true`;
2. obtain a fingerprint for every registered repository with an injected helper, fail closed into `{status:"failed", reason}` if any cannot be read;
3. call Task 1 builder then `deps.startPostVerifyCritic` (or the live service adapter);
4. catch every construction/start error and return bounded `{status:"failed", reason}`.

Do not call it before persistence and do not wrap the matrix/evidence return in a way that converts an advisory failure into a verify failure.

Extend `readLatestVerificationEvidence` to retain the normalized raw event/digest required by Task 1, while keeping its existing public `verifiedEvidence` projection backward-compatible. Have `resultCommand` call `publicPostVerifyCritic({delegations: run.delegations, latestVerification})` and attach the optional `critic` field.

- [ ] **Step 4: Escribir los tests rojos de result freshness y format**

Create one persisted successful verification and a matching terminal critic record, then assert `result.critic.status === "completed"` and the blocker finding survives compact and JSON formatting. Append a later failed verification event and assert `result.critic.status === "stale"` while `result.status`/`exitCode` do not change. Add an overlong findings fixture and assert JSON remains valid and bounded with a truncation marker, preserving each shown severity and the critic stale marker.

- [ ] **Step 5: Implementar projection y render**

Add a compact `Critic:` block after verification evidence in `formatResult`, containing status, delegation id, review digest short form, each finding as `[BLOCKER] path — summary`, and a next action `workflow delegation result <runId> <delegationId>` when one exists. JSON must retain the structured critic object. Extend `resultOverflowFallback` to bound finding `summary`/`evidence` before choosing the generic fallback; never stringify findings into concerns or discard severity while a critic block remains.

- [ ] **Step 6: Ejecutar suites focalizadas**

Run:

```bash
WORKFLOW_PROJECTS_FILE= npx node --test \
  test/workflow-commands.test.js \
  test/workflow-format.test.js
```

Expected: PASS, including non-gating, stale, compact and bounded JSON cases.

- [ ] **Step 7: Commit**

```bash
git add src/workflow/commands.js src/workflow/format.js \
  test/workflow-commands.test.js test/workflow-format.test.js
git commit -m "feat: launch and surface advisory critics after verify"
```

### Task 5: Cableado CLI, rol y cierre documental

**Files:**
- Modify: `bin/workflow.js`
- Modify: `.pi/agents/code-reviewer.md`
- Modify: `README.md`
- Modify: `ROADMAP.md`
- Test: `test/workflow-cli.test.js`
- Test: `test/workflow-docs.test.js`

**Interfaces:**

- Consumes Task 3 service method and Task 4 injected starter.
- Produces a live `verify` path that creates the same Pi delegation transport via `withLiveDelegationTransport()` used by existing delegation commands; no new positional/options syntax.

- [ ] **Step 1: Escribir el test rojo de wiring CLI**

In the CLI fixture, invoke `workflow verify <uuid> --format json` with a passed verify result and assert `withLiveDelegationTransport` is reached only for that passed+persistent path, the injected service receives `startPostVerifyCritic`, and the output carries the delegation id. Add a failed verify fixture that asserts Pi lookup/spawn never happens.

- [ ] **Step 2: Ejecutar para verificar que falla**

Run: `WORKFLOW_PROJECTS_FILE= npx node --test test/workflow-cli.test.js`

Expected: FAIL because the verify dispatch currently invokes `verifyCommand(options, liveDependencies)` without a delegation transport/starter.

- [ ] **Step 3: Implementar wiring sin nueva sintaxis**

In the `args.command === "verify"` branch, inject a lazy `startPostVerifyCritic({store, registry, run, input})` factory. Only when Task 4 calls it, invoke `withLiveDelegationTransport`; then construct `createDelegationStore({store})`, `createDelegationReservationStore({stateRoot, readOwnOwnership})`, and `createDelegationServices({registry, projectAlias: run.projectAlias, runStore: store, delegations, reservations, transport, roles: dependencies.roles ?? {loadDelegationRole: defaultLoadDelegationRole}})`, and call its `startPostVerifyCritic({runId: run.id, input})`. Add the necessary imports rather than calling `delegationServicesForContext`, which is private to `commands.js`. Do not resolve Pi or spawn it for failed/refused/persistence-error verifies. Ensure a Pi preflight/start failure becomes Task 4’s advisory `critic.status: "failed"`, not a CLI preflight failure.

- [ ] **Step 4: Documentar el contract exacto**

Update `.pi/agents/code-reviewer.md` with an exact result example:

```json
{"status":"completed","generation":1,"summary":"...","verification":[],"concerns":[],"findings":[{"severity":"concern","summary":"...","evidence":"...","path":"src/x.js"}],"nextAction":"Review the concern"}
```

State explicitly: only system post-verify critic handoffs may include `findings`; a blocker is advisory; do not edit/push/deploy/cleanup. Update README with automatic start conditions and CLI visibility. At close-out update the existing Roadmap 2.6 line with the exact commit range produced by `git rev-parse <first-critic-commit>^` and `git rev-parse HEAD`, then add a brief closure narrative and docs tests for those claims.

- [ ] **Step 5: Ejecutar tests focalizados**

Run:

```bash
WORKFLOW_PROJECTS_FILE= npx node --test \
  test/workflow-cli.test.js \
  test/workflow-docs.test.js
```

Expected: PASS. The failed-verify fixture proves no Pi spawn; the passed fixture proves the critic is advisory in output.

- [ ] **Step 6: Ejecutar suite completa y commit**

Run: `WORKFLOW_PROJECTS_FILE= npm run test:ci-like`

Expected: all tests pass, 0 failures, 0 skips.

```bash
git add bin/workflow.js .pi/agents/code-reviewer.md README.md ROADMAP.md \
  test/workflow-cli.test.js test/workflow-docs.test.js
git commit -m "docs: complete automatic post-verify critic"
```

## Final Verification and Review

- [ ] Run `WORKFLOW_PROJECTS_FILE= npm run test:ci-like` from the exact branch to integrate.
- [ ] Review `git diff main...HEAD` adversarially for four failure modes: critic launched before durable evidence; a generic delegation accepted `findings`; `blocker` gates any canonical path; stale critic appears fresh after a later failed verify.
- [ ] Request/reproduce an independent review, fix every Critical/Important finding, then repeat the focused tests and the entire suite.
- [ ] Rebase onto current `main`; rerun the full suite; merge/push only with explicit approval; confirm the CI run for the pushed SHA is green.
