# Critic advisory automático post-verify — diseño

**Fecha:** 2026-08-26  
**Ítem:** Roadmap 2.6  
**Estado:** diseño aprobado

## Objetivo

Después de que `workflow verify <run-id>` haya ejecutado y **persistido** una matriz completamente
exitosa, iniciar automáticamente un critic Pi read-only que compare el diff actual de los
worktrees del run con el `assignment.md` aprobado. El resultado es evidencia advisory: informa al
operador, nunca modifica código, nunca cambia el estado canónico del run y nunca bloquea `merge`.

Esto cierra el último ítem de Fase 2 sin añadir una cola, un prompt de confirmación ni una nueva
lane canónica.

## Alcance y no objetivos

Incluye:

- lanzamiento background del rol existente `code-reviewer` tras un verify persistido y exitoso;
- brief congelado que ata la review al assignment, a la evidencia de verify y a los worktrees
  registrados;
- hallazgos estructurados con severidad `aside`, `concern` o `blocker`;
- exposición del critic más reciente desde `workflow verify` y `workflow result`;
- stale explícito cuando un critic ya no corresponde al último verify exitoso.

No incluye:

- gatear merge, archive, lifecycle o handoff sobre el critic;
- pedir confirmación, crear previews/digests de aprobación humanos, reintentar en silencio o
  introducir una cola/watcher nuevo;
- permitir edición, subdelegación, cleanup, deploy o push;
- sustituir `workflow delegation result`, que conserva la vista detallada de una delegación;
- convertir la frontera read-only de herramientas en sandbox de sistema operativo.

## Disparador y flujo

1. `verifyCommand` conserva su matriz actual y calcula `passed`.
2. Si el verify se rehúsa, falla, o `appendEvent({type: "verification", ...})` falla, no se
   inicia critic. El resultado sigue exponiendo la verificación normal y, en el último caso,
   `evidenceError`; no existe evidencia durable que el critic pueda revisar honestamente.
3. Si `passed === true` y la escritura del evento termina, el comando construye una identidad
   inmutable `reviewOf` a partir del evento de verify recién persistido (su digest canónico), el
   assignment digest/path del run y los fingerprints Git actuales de los worktrees.
4. Se inicia una sola delegación `code-reviewer`, `background`, `concurrency: 1`, usando el
   transporte Pi y la policy de delegación ya existentes. `verify` espera solamente la respuesta
   de start que registra identidad/reserva; nunca espera la review.
5. El comando responde con `critic`: `{status: "running"|"failed", delegationId, reviewOf}`.
   Un fallo de reserva, policy, rol o transporte queda allí como evidencia advisory y no cambia
   `passed` ni el exit code de verify.
6. El child entrega su resultado por el handoff advisory existente. El resultado se guarda en la
   delegación, no en el handoff canónico ni en `result.json` del worker externo.

No hay dedupe entre invocaciones distintas de `verify`: cada evento exitoso persistido merece su
propia review. La policy existente limita concurrencia. Una review anterior permanece como
historial; la presentación de alto nivel la considera actual solo si su `reviewOf` coincide con el
**último evento de verify persistido**. Por eso una nueva verificación fallida también vuelve stale
la opinión anterior: el diff que aquella leyó ya no es la última evidencia disponible.

## Origen y ownership

Una delegación automática no puede fingir ser una sesión Pi humana. Se introduce el origen
explícito `system-post-verify`, separado de `originSessionId`, y se persiste junto a `reviewOf` en
el record de delegación. Ese origen:

- no usa ni recibe entrega del watcher de sesiones;
- hace que el resultado sea visible por CLI (`workflow result` y `workflow delegation result`), no
  un mensaje dirigido a una sesión inexistente;
- conserva el invariante actual: toda salida interna es advisory y no puede completar/cerrar el run.

Las delegaciones interactivas existentes mantienen su `originSessionId` y su entrega exacta sin
cambios. El nuevo origen es deliberadamente un caso tipado, no un string que parezca session ID.

## Brief congelado

El builder del critic produce un task y brief acotados que contienen únicamente:

- run ID y alias del proyecto;
- path absoluto y digest de `assignment.md`;
- `reviewOf` y el resumen de la evidencia de verify que pasó;
- cada worktree registrado y su fingerprint observado;
- instrucciones de comparar el diff contra el assignment, inspeccionar tests/configuración
  relevante, no modificar archivos y devolver hallazgos con las severidades definidas.

No incluye transcript, stdout/stderr completo de tests, secretos ni una instrucción de resolver los
hallazgos. El rol `code-reviewer` existente conserva su set read-only y la prohibición de
subagentes/mutaciones.

## Resultado del critic

El contrato advisory genérico actual conserva `concerns: string[]` para roles existentes. Para una
delegación cuyo origen sea `system-post-verify` y rol `code-reviewer`, el handoff además acepta un
campo opcional `findings` limitado a 20 entradas:

```json
{
  "severity": "aside | concern | blocker",
  "summary": "texto acotado",
  "evidence": "texto acotado",
  "path": "ruta relativa opcional"
}
```

Cada objeto se valida estrictamente: claves conocidas, severidad del vocabulario cerrado, textos
acotados y path relativo sin NUL ni traversal. `findings` no reemplaza `concerns`; el critic puede
usar ambos, pero la presentación prioriza los hallazgos estructurados. Un handoff de otro rol u
origen que intente aportar `findings` se rehúsa: la extensión no expande por accidente el contrato
genérico.

`workflow result` agrega un campo `critic` con la delegación `system-post-verify` más reciente:

- `pending` mientras corre;
- `completed`, `blocked` o `failed` con `summary`, `findings`, `concerns` y `nextAction`;
- `stale` si su `reviewOf` no coincide con el último evento de verify persistido (incluido uno
  fallido).

El valor es diagnóstico solamente. En particular, `blocker` significa “el reviewer halló algo que
un humano debería revisar”, no una transición, un exit code ni un permiso negado.

## Fallos y consistencia

- Verify fallido/refused o evidencia no persistida: no critic, sin side effect nuevo.
- Error al iniciar critic: `verify` conserva `passed: true`/exit 0 y devuelve el error advisory
  acotado; no retry automático.
- Handoff inválido, child ausente o resultado stale: se aplican los estados y reconciliación de
  delegación existentes; jamás se convierte en éxito ni en evidencia canónica.
- Cualquier nuevo verify persistido hace stale a la presentación del critic anterior por
  `reviewOf`; no borra el record histórico. Uno exitoso además inicia su propio critic nuevo.
- Un fingerprint/diff que cambia tras iniciar la review no invalida verify ni merge por sí mismo;
  deja el critic stale para impedir que una opinión vieja se presente como actual.

## Cambios de arquitectura

- `commands.js`: factorizar el post-éxito de `verifyCommand` detrás de una dependencia inyectable
  `startPostVerifyCritic`; construir y devolver el campo `critic` sin cambiar los exit codes de
  verify.
- Nuevo módulo pequeño de dominio (por ejemplo `post-verify-critic.js`): construir `reviewOf`,
  validar/selectar el critic actual, y construir task/brief. No mezclar ese conocimiento en
  `delegation-services.js`.
- `delegation-store.js`/`delegation-handoff.js`: persistir origen tipado y metadata `reviewOf`; validar
  `findings` exclusivamente para ese origen+rol.
- `commands.js`/`format.js`: proyectar `critic` en `workflow result`, compacto y JSON, con límites
  de salida existentes.
- `bin/workflow.js`: cablear el transporte Pi/dependencias para el auto-start que ya cablea a los
  comandos de delegación. No se agrega sintaxis CLI nueva.
- `.pi/agents/code-reviewer.md`: especificar el formato de findings y que un `blocker` sigue siendo
  advisory.
- `docs/run-record-fields.md`, README y ROADMAP: documentar el record extendido y el comportamiento
  auto-start/advisory.

## Pruebas de aceptación

1. Verify exitoso con evento persistido inicia exactamente un critic background y devuelve su id,
   `reviewOf` y estado de start.
2. Verify fallido, refused o con `evidenceError` no inicia transporte, reserva ni delegación.
3. Un fallo de start no cambia `passed`, `exitCode` ni los resultados de verify, y queda visible
   como critic advisory fallido.
4. El brief contiene assignment/digest, worktrees/fingerprints y evidencia de verify; no contiene
   output sensible ni autoridad de escritura.
5. El record tipado no es entregado a una sesión humana; una delegación interactiva existente sigue
   teniendo su ownership/delivery exactos.
6. Handoff acepta hallazgos válidos solo para el critic, rechaza severidad/keys/path inválidos y
   mantiene el límite de 20.
7. `workflow result` muestra pending/terminal, hallazgos y staleness; una nueva verificación
   persistida —exitosa o fallida— deja el critic anterior fuera de la presentación actual sin borrar
   historial. Una exitosa inicia el critic nuevo.
8. `merge` y `archive` conservan exactamente sus gates y exit codes con critic `blocker`, `failed`
   o ausente.
9. Suite completa `npm run test:ci-like` y tests de formato/documentación permanecen verdes.
