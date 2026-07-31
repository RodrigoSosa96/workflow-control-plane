// Shared twelve-step choreography for removing a mutex whose owner is proven dead.
//
// run-store.js's removeLock and delegation-reservations.js's clearGate are the only code in
// this repository that removes crash residue: the standing policy everywhere else is that
// residue is preserved and reported, never removed automatically. These two run only behind a
// confirmed operator command, and only after the caller's `allow` predicate has proven the
// marker's owner is dead. Before this file existed the two stores carried byte-for-byte
// identical copies of this algorithm with different nouns, and had already required one
// synchronized fix across both files (dc55ba4, the stray-entry guard below) — the risk of one
// shared copy is smaller than the risk of the two drifting the next time a hazard like that one
// is found.
//
// Every refusal branch below exists because a specific hazard was found. In order:
//   1. inspect; refuse if the target or its marker is absent (an ambiguous multi-marker
//      directory, where the store distinguishes it, gets its own reason instead of being
//      lumped in with "nothing here").
//   2. `await allow(marker)`; refuse if not permitted.
//   3. inspect again; refuse if the target or its marker disappeared in the meantime.
//   4. refuse if the directory identity changed since step 1 (dev/ino, falling back to
//      ctime/mtime) — a replacement mutex acquired in the allow() window must not be destroyed
//      just because it happens to sit at the same path.
//   5. refuse if the marker's path or raw bytes changed since step 1 — same hazard, caught by
//      content instead of identity, because a replacement acquisition could theoretically reuse
//      the same directory identity on some filesystems.
//   6. refuse if the directory holds anything besides the marker (dc55ba4): unlinking the
//      marker first and discovering a stray entry only at rmdir would leave the mutex wedged
//      with no marker to recover from, destroying the ownership evidence this mechanism exists
//      to preserve. Refuse before deleting anything.
//   7. unlink the marker; ENOENT/ENOTDIR is a graceful refusal (a normal concurrent release),
//      not an anomaly.
//   8. stat the directory again; ENOENT/ENOTDIR is again a graceful refusal.
//   9. refuse if the directory identity changed since step 3 — the marker is already gone at
//      this point, so only a fresh identity check stands between here and rmdir-ing a
//      replacement acquisition nobody ever inspected.
//   10. rmdir. This is the one step that throws instead of refusing: by this point the marker
//       is already gone, so an anomaly here can no longer be resolved by silently declining —
//       it must be reported. `onRmdirError` lets each store keep its own throw; the two differ
//       deliberately (one uses a shared error constructor, the other its own fail()) and must
//       still be called even if this function's own fallback throw never fires.
//   11. success.
//
// `fs.unlink`/`fs.stat`/`fs.rmdir` are called directly on the `fs` passed in. Steps 7 and 8's
// "refuse on ENOENT/ENOTDIR, otherwise throw" behavior is deliberately naive here: any other
// error is rethrown completely unwrapped. Both stores wrap `fs` with their own thin adapter
// before handing it to this function precisely so that "otherwise throw" comes out already
// formatted the way that store has always formatted it — this file does not know either store's
// error-wrapping convention, and must not invent a third one.
import { sameOwnerDirectory } from "./ownership.js";

export async function removeOwnedMutex({ inspect, allow, fs, noun, onRemoved, onRmdirError }) {
  const initial = await inspect();
  if (!initial || !initial.marker) {
    const reason = initial?.markerAmbiguous
      ? "more than one owner marker is present; refusing rather than guessing which is authoritative"
      : `no ${noun} or the owner marker is unreadable`;
    return { refused: true, reason };
  }

  const permitted = await allow(initial.marker);
  if (!permitted) {
    return { refused: true, reason: "removal was not permitted for the current owner marker" };
  }

  const recheck = await inspect();
  if (!recheck || !recheck.marker) {
    return { refused: true, reason: `the ${noun} or its owner marker disappeared before removal` };
  }
  if (!sameOwnerDirectory(recheck.dirStat, initial.dirStat)) {
    return { refused: true, reason: `the ${noun} directory was replaced before removal` };
  }
  if (recheck.markerPath !== initial.markerPath || recheck.markerText !== initial.markerText) {
    return { refused: true, reason: "the owner marker changed before removal" };
  }
  // A directory holding anything besides the marker (a stray .DS_Store, an editor temp — exactly
  // what `inspect` already tolerates when identifying the marker) would make the rmdir below fail
  // with ENOTEMPTY *after* the marker is already gone: the mutex stays wedged, but now with no
  // marker to recover from, destroying the pid/startedAt evidence this whole mechanism exists to
  // preserve. Refuse before unlinking anything instead. (dc55ba4)
  if (recheck.entries.length !== 1) {
    return {
      refused: true,
      reason: `the ${noun} directory holds entries besides the owner marker; refusing before deleting anything to avoid destroying ownership evidence`,
    };
  }

  try {
    await fs.unlink(recheck.markerPath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return { refused: true, reason: "the owner marker disappeared before removal" };
    }
    throw error;
  }

  // The marker is gone; re-verify the directory itself one more time before rmdir-ing it. Nothing
  // should legitimately replace it this fast, but if it happened (a fresh acquisition landing in
  // the window between the unlink above and here), rmdir-ing it unverified would destroy a live
  // acquisition this function never inspected.
  let postUnlinkStat;
  try {
    postUnlinkStat = await fs.stat(recheck.dirPath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return { refused: true, reason: `the ${noun} directory disappeared before removal` };
    }
    throw error;
  }
  if (!postUnlinkStat.isDirectory() || !sameOwnerDirectory(postUnlinkStat, recheck.dirStat)) {
    return { refused: true, reason: `the ${noun} directory was replaced before removal` };
  }

  try {
    await fs.rmdir(recheck.dirPath);
  } catch (error) {
    onRmdirError(error, recheck);
    // onRmdirError is contracted to throw; this is only a safety net if it somehow doesn't.
    throw error;
  }

  return onRemoved(recheck);
}
