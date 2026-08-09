# Cotas de spawn y fail-closed: batch de pendientes

**Fecha:** 2026-08-09
**Estado:** Propuesto
**Alcance:** ocho entradas de "Pendientes conocidos" de `ROADMAP.md`, agrupadas porque comparten
una sola propiedad. No es un ítem numerado del roadmap.

## Problema

Este repo afirma dos invariantes que no se sostienen del todo.

**"Todo spawn está acotado."** No lo está. `createProcessRunner` (`process.js`) arma su timeout
como `child.kill("SIGTERM")` sobre el hijo **directo** y resuelve la promesa en el evento `close`,
que espera a que se cierren todos los pipes. Medido durante la review de la tarea 1 de 2.5:
`sh -c 'sleep 30'` con `timeoutMs: 500` rechaza a los **30.002 ms** con el mensaje diciendo
literalmente `timed out after 500ms`, y un script que backgroundea un hijo y sale **resuelve** a los
30 s. El ítem 2.3 arregló exactamente esta clase adentro de `verify-runner.js` —grupo de procesos,
escalada a SIGKILL— y nunca se llevó al runner compartido, que es el que usan git y Herdr.

**"Lo desconocido falla cerrado."** Casi siempre. Quedan tres lugares donde no: el status
`already-up-to-date` de merge se decide con `every(entry => entry.integrated === false)`, así que un
no-op mezclado con una lectura fallida (`integrated === null`) reporta `merged`; `git.mergeArgv` es
la última llamada al adapter sin envolver en `inspectRepositoryForMerge`; y merge nunca recibió la
detección de operación en curso que 2.5 le dio a archive.

Y hay tres spawns sin cota: la relectura post-merge de `resolveHead`, las lecturas git de las
previews de merge y archive (`checkoutState`/`resolveHead`, que ni siquiera aceptan `timeoutMs`), y
un `timeoutMs` explícito pero inusable en `closeTab` que se descarta en vez de caer al default.

## Decisión

Ocho arreglos, una propiedad: **todo spawn tiene una cota real de reloj, y todo desconocido
rehúsa.**

### B1 — El timeout de `process.js` acota el reloj, no solo señaliza

Es el único defecto medido del batch y el que da sentido a los demás: poner `timeoutMs` en más
llamadas no sirve de nada si el timeout no acota.

Se adopta la forma que 2.3 ya validó en `verify-runner.js`: `detached: true` para que el hijo
lidere su propio grupo, señal al **grupo entero** (`process.kill(-pid, …)`) al vencer, y escalada a
`SIGKILL` tras una ventana de gracia, de modo que el reloj quede acotado por
`timeoutMs + killGraceMs` incluso contra un comando que atrapa SIGTERM.

**La trampa está documentada y hay que respetarla.** En 2.3 ese mismo `detached: true` sacó al hijo
del grupo de procesos del CLI y **rompió Ctrl-C**: la señal del terminal va al grupo *foreground*,
no a este proceso por pid, así que un CLI interrumpido salía dejando al hijo reparentado a init sin
cota alguna —y la escalada vive dentro del proceso que acaba de morir. `verify-runner.js` lo cerró
con un trap SIGINT/SIGTERM instalado por hijo vivo que mata el grupo antes de salir. Acá hace falta
lo mismo, con una diferencia que importa: `process.js` es el runner **compartido**, corre muchos
comandos cortos y a veces concurrentes, así que el trap tiene que ser por hijo, con teardown
garantizado, y no puede quedar registrado cuando no hay hijos vivos.

**Segunda diferencia con `verify-runner.js`, y es la razón por la que esto no es un copy-paste:**
aquel resuelve en `close` a propósito, porque su trabajo es capturar la salida entera de un comando
de verificación. Acá `close` es justamente lo que rompe la cota. La salida sigue capturándose, pero
el settle deja de depender de que todos los pipes se cierren.

**Lo que no cambia:** `shell: false`, la forma del `WorkflowError` (`reason: "timeout"`, el mismo
`exitCode`), el cap de salida de 12.000 caracteres, y el contrato de `allowFailure`. Es una
corrección de cota, no un rediseño del runner.

### B2, B3, B4 — Las cotas que faltan, que recién ahora significan algo

- **B2:** la relectura post-merge de `resolveHead` (`commands.js`) recibe `timeoutMs`. Es el único
  spawn del camino de **ejecución** de merge sin cota, y corre *después* de que existan commits de
  merge reales —el peor lugar para colgarse.
- **B3:** `checkoutState` y `resolveHead` aceptan `timeoutMs` en el adapter (hoy no tienen el
  parámetro), y merge y archive se lo pasan en sus previews. Sin B1 esto sería cosmético; con B1
  acota de verdad.
- **B4:** `closeTab` usa un default de parámetro, así que `undefined` cae al default pero `null`,
  `0`, `NaN`, `-5` y `"10000"` se pasan y los descarta el chequeo de finitud de `run()` —dejando sin
  cota justamente la llamada cuyo comentario dice que tiene que tenerla. Un valor inusable cae al
  default en vez de desactivar la cota.

### B5, B6, B7 — Los tres fail-open que quedan

- **B5:** `git.mergeArgv` se envuelve como las demás llamadas al adapter en
  `inspectRepositoryForMerge`. Es síncrona y devuelve un array literal, así que la exposición es
  teórica —pero es la misma clase que la review de 2.4 cerró para `previewMerge`, y el archivo
  declara el principio de no depender de un contrato que otro módulo podría cambiar.
- **B6:** `nothingIntegrated` pasa a exigir que **ninguna** entrada tenga `integrated === null`. Una
  lectura fallida mezclada con un no-op genuino no puede reportar `merged`: hoy la fila propia dice
  `merged (UNCONFIRMED)` mientras el status de arriba dice `merged`, que es la misma discordancia
  vista/veredicto que el batch de archive removió.
- **B7:** merge usa `git.pendingOperation` como archive, en vez de `checkoutState`'s `merging`. Un
  base checkout a mitad de un rebase, cherry-pick o revert recibe hoy la guía equivocada —o ninguna—
  donde archive ya nombra la remediación correcta. Es cerrar la asimetría que 2.5 dejó abierta.

### B8 — Los números de tier vuelven a ser medidos

La tabla de tiers de overflow de archive (`format.js`) y el "about sixteen repositories" del README
quedaron sin re-medir después de que C1/I1 agregaran cuatro campos por repositorio y hasta seis por
pérdida. El comportamiento es dirigido por tamaño, así que degrada bien igual; lo que está mal es
que los números se leen como medidos y ya no lo son. Este documento tiene una regla explícita sobre
no dejar estimaciones vestidas de medición.

## Fuera de alcance, y por qué

No todo pendiente es un defecto. Quedan afuera deliberadamente:

- **Decisiones de diseño ya tomadas:** la no-atomicidad de merge entre repositorios, la ventana
  TOCTOU preview→merge que `launch` comparte, los objetos sueltos que escribe `merge-tree
  --write-tree`, y la asimetría "lo no commiteado rehúsa / lo no mergeado avisa".
- **Pendientes cuyo cierre real es un ítem posterior:** aislamiento same-uid (**4.1**), el `paneId`
  stale de `executeResume` (**4.4**), la rotación de `events.jsonl` (**4.7**).
- **Notas, no defectos:** las dos clases de residuo que archive deja a propósito, la forma de cinco
  `if` de `archiveLosses` sostenida por un comentario, el doble preview de `merge --yes`.
- **Capacidad sin usuario:** `list({unconsumed: true})` filtra sobre un campo que nada escribe;
  resolverlo es decidir si se usa o se borra, y eso es una decisión, no un arreglo.
- **`workflow delegation release` sin digest**, que el propio pendiente condiciona a "si el comando
  se usa seguido".

## Estrategia de verificación

1. **B1 medido, no argumentado.** Los dos casos que hoy fallan —`sh -c 'sleep 30'` y un script que
   backgroundea y sale— con `timeoutMs: 500`, tienen que rechazar cerca del deadline en vez de a los
   30 s, y sin dejar procesos huérfanos (verificado con `ps`, como hizo 2.3).
2. **Ctrl-C sigue funcionando.** Un test que pruebe que una interrupción entregada a este proceso
   mata al grupo del hijo antes de salir. Es la regresión exacta que introdujo el fix de 2.3.
3. **El trap no queda registrado** cuando no hay hijos vivos, y no se acumula entre spawns
   secuenciales ni concurrentes.
4. B2/B3/B4: el `timeoutMs` llega al `runner.run` correspondiente (aserción sobre la llamada
   registrada), y un valor inusable en `closeTab` cae al default en vez de desactivar la cota.
5. B5: un adapter que tira convierte la preview en refusal, no en stack trace.
6. B6: una entrada `integrated === null` mezclada con un no-op genuino **no** reporta `merged`.
7. B7: un base checkout a mitad de rebase/cherry-pick/revert rehúsa nombrando su propia remediación.
8. B8: cada número de la tabla re-medido contra el fixture que la tabla nombra.
9. `npm run test:ci-like` en verde, cero skips.

## Criterios de aceptación

- Ningún comando de este CLI puede colgarse indefinidamente por un subproceso que ignora SIGTERM o
  deja un descendiente sobre su stdio.
- Ctrl-C sigue matando lo que arrancó, y no queda huérfano nada.
- Ningún desconocido —una lectura fallida, un adapter que tira, una operación git en curso— se
  reporta como éxito.
- Los números publicados vuelven a ser mediciones.
