import assert from "node:assert/strict";
import { test } from "node:test";
import { removeOwnedMutex } from "../src/workflow/mutex-removal.js";

const NOUN = "active widget";
const DIR_A = { dev: 1, ino: 100 };
const DIR_A_SAME = { dev: 1, ino: 100 }; // distinct object, same identity
const DIR_B = { dev: 1, ino: 200 }; // different identity

function shape(overrides = {}) {
  return {
    dirPath: "/state/widget/active",
    dirStat: DIR_A,
    markerPath: "/state/widget/active/owner.json",
    markerText: '{"pid":"1"}\n',
    marker: { pid: "1" },
    entries: ["owner.json"],
    ...overrides,
  };
}

// Returns an async function that yields `results` in order (by call count), like the
// clockSequence/uuidSequence pattern the store test files already use. Exposes `.calls` so a
// test can assert exactly how many times `inspect` ran (removeOwnedMutex must call it exactly
// once per branch it reaches: once for a refusal before step 2, twice for anything that gets as
// far as the recheck).
function inspectSequence(...results) {
  const calls = [];
  const fn = async () => {
    const index = calls.length;
    calls.push(index);
    return results[index] ?? results.at(-1);
  };
  fn.calls = calls;
  return fn;
}

function fakeFs({ unlinkError, postUnlinkStat, statError, rmdirError } = {}) {
  const calls = { unlink: [], stat: [], rmdir: [] };
  return {
    calls,
    async unlink(path) {
      calls.unlink.push(path);
      if (unlinkError) throw unlinkError;
    },
    async stat(path) {
      calls.stat.push(path);
      if (statError) throw statError;
      return postUnlinkStat ?? { isDirectory: () => true, ...DIR_A };
    },
    async rmdir(path) {
      calls.rmdir.push(path);
      if (rmdirError) throw rmdirError;
    },
  };
}

function fsCode(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function neverAllow() {
  throw new Error("allow() must not be called on this branch");
}

function neverOnRemoved() {
  throw new Error("onRemoved must not be called on a refusal");
}

function neverOnRmdirError() {
  throw new Error("onRmdirError must not be called unless rmdir fails");
}

test("removeOwnedMutex refuses with the absent-target reason when inspect finds nothing, without calling allow", async () => {
  const inspect = inspectSequence(null);
  const result = await removeOwnedMutex({
    inspect,
    allow: neverAllow,
    fs: fakeFs(),
    noun: NOUN,
    onRemoved: neverOnRemoved,
    onRmdirError: neverOnRmdirError,
  });
  assert.deepEqual(result, { refused: true, reason: `no ${NOUN} or the owner marker is unreadable` });
  assert.equal(inspect.calls.length, 1);
});

test("removeOwnedMutex refuses with the absent-target reason when the marker is unreadable (marker: null, not ambiguous)", async () => {
  const inspect = inspectSequence(shape({ marker: null, markerPath: null, markerText: null }));
  const result = await removeOwnedMutex({
    inspect,
    allow: neverAllow,
    fs: fakeFs(),
    noun: NOUN,
    onRemoved: neverOnRemoved,
    onRmdirError: neverOnRmdirError,
  });
  assert.deepEqual(result, { refused: true, reason: `no ${NOUN} or the owner marker is unreadable` });
  assert.equal(inspect.calls.length, 1);
});

test("removeOwnedMutex refuses with the ambiguity-specific reason when markerAmbiguous is set", async () => {
  const inspect = inspectSequence(shape({ marker: null, markerPath: null, markerText: null, markerAmbiguous: true }));
  const result = await removeOwnedMutex({
    inspect,
    allow: neverAllow,
    fs: fakeFs(),
    noun: NOUN,
    onRemoved: neverOnRemoved,
    onRmdirError: neverOnRmdirError,
  });
  assert.deepEqual(result, {
    refused: true,
    reason: "more than one owner marker is present; refusing rather than guessing which is authoritative",
  });
});

test("removeOwnedMutex calls allow with the initial marker and refuses without touching fs when it returns false", async () => {
  const initial = shape();
  const inspect = inspectSequence(initial);
  let seenMarker;
  const result = await removeOwnedMutex({
    inspect,
    allow: async (marker) => {
      seenMarker = marker;
      return false;
    },
    fs: fakeFs(),
    noun: NOUN,
    onRemoved: neverOnRemoved,
    onRmdirError: neverOnRmdirError,
  });
  assert.equal(seenMarker, initial.marker);
  assert.deepEqual(result, { refused: true, reason: "removal was not permitted for the current owner marker" });
  assert.equal(inspect.calls.length, 1, "allow()===false must refuse before the recheck inspect");
});

test("removeOwnedMutex refuses when the target disappears before the recheck", async () => {
  const inspect = inspectSequence(shape(), null);
  const fs = fakeFs();
  const result = await removeOwnedMutex({
    inspect,
    allow: () => true,
    fs,
    noun: NOUN,
    onRemoved: neverOnRemoved,
    onRmdirError: neverOnRmdirError,
  });
  assert.deepEqual(result, { refused: true, reason: `the ${NOUN} or its owner marker disappeared before removal` });
  assert.equal(fs.calls.unlink.length, 0);
});

test("removeOwnedMutex refuses when the recheck's marker is unreadable", async () => {
  const inspect = inspectSequence(shape(), shape({ marker: null, markerPath: null, markerText: null }));
  const result = await removeOwnedMutex({
    inspect,
    allow: () => true,
    fs: fakeFs(),
    noun: NOUN,
    onRemoved: neverOnRemoved,
    onRmdirError: neverOnRmdirError,
  });
  assert.deepEqual(result, { refused: true, reason: `the ${NOUN} or its owner marker disappeared before removal` });
});

test("removeOwnedMutex refuses when the directory identity changed between the initial inspect and the recheck", async () => {
  const inspect = inspectSequence(shape({ dirStat: DIR_A }), shape({ dirStat: DIR_B }));
  const fs = fakeFs();
  const result = await removeOwnedMutex({
    inspect,
    allow: () => true,
    fs,
    noun: NOUN,
    onRemoved: neverOnRemoved,
    onRmdirError: neverOnRmdirError,
  });
  assert.deepEqual(result, { refused: true, reason: `the ${NOUN} directory was replaced before removal` });
  assert.equal(fs.calls.unlink.length, 0, "must refuse before unlinking anything");
});

test("removeOwnedMutex treats matching-but-distinct dirStat objects as the same directory (sameOwnerDirectory, not reference equality)", async () => {
  const inspect = inspectSequence(shape({ dirStat: DIR_A }), shape({ dirStat: DIR_A_SAME }));
  const fs = fakeFs();
  const onRemoved = (recheck) => ({ removed: true, recheck });
  const result = await removeOwnedMutex({
    inspect,
    allow: () => true,
    fs,
    noun: NOUN,
    onRemoved,
    onRmdirError: neverOnRmdirError,
  });
  assert.equal(result.removed, true);
});

test("removeOwnedMutex refuses when the marker path changed between the initial inspect and the recheck", async () => {
  const inspect = inspectSequence(shape(), shape({ markerPath: "/state/widget/active/owner-different.json" }));
  const result = await removeOwnedMutex({
    inspect,
    allow: () => true,
    fs: fakeFs(),
    noun: NOUN,
    onRemoved: neverOnRemoved,
    onRmdirError: neverOnRmdirError,
  });
  assert.deepEqual(result, { refused: true, reason: "the owner marker changed before removal" });
});

test("removeOwnedMutex refuses when the marker bytes changed between the initial inspect and the recheck", async () => {
  const inspect = inspectSequence(shape(), shape({ markerText: '{"pid":"2"}\n' }));
  const result = await removeOwnedMutex({
    inspect,
    allow: () => true,
    fs: fakeFs(),
    noun: NOUN,
    onRemoved: neverOnRemoved,
    onRmdirError: neverOnRmdirError,
  });
  assert.deepEqual(result, { refused: true, reason: "the owner marker changed before removal" });
});

test("removeOwnedMutex refuses when the directory holds entries besides the marker, before unlinking anything (dc55ba4)", async () => {
  const inspect = inspectSequence(shape(), shape({ entries: ["owner.json", ".DS_Store"] }));
  const fs = fakeFs();
  const result = await removeOwnedMutex({
    inspect,
    allow: () => true,
    fs,
    noun: NOUN,
    onRemoved: neverOnRemoved,
    onRmdirError: neverOnRmdirError,
  });
  assert.deepEqual(result, {
    refused: true,
    reason: `the ${NOUN} directory holds entries besides the owner marker; refusing before deleting anything to avoid destroying ownership evidence`,
  });
  assert.equal(fs.calls.unlink.length, 0);
});

test("removeOwnedMutex refuses gracefully (not a throw) when unlink reports ENOENT", async () => {
  const inspect = inspectSequence(shape(), shape());
  const fs = fakeFs({ unlinkError: fsCode("ENOENT") });
  const result = await removeOwnedMutex({
    inspect,
    allow: () => true,
    fs,
    noun: NOUN,
    onRemoved: neverOnRemoved,
    onRmdirError: neverOnRmdirError,
  });
  assert.deepEqual(result, { refused: true, reason: "the owner marker disappeared before removal" });
});

test("removeOwnedMutex refuses gracefully (not a throw) when unlink reports ENOTDIR", async () => {
  const inspect = inspectSequence(shape(), shape());
  const fs = fakeFs({ unlinkError: fsCode("ENOTDIR") });
  const result = await removeOwnedMutex({
    inspect,
    allow: () => true,
    fs,
    noun: NOUN,
    onRemoved: neverOnRemoved,
    onRmdirError: neverOnRmdirError,
  });
  assert.deepEqual(result, { refused: true, reason: "the owner marker disappeared before removal" });
});

test("removeOwnedMutex rethrows an unlink error that is not ENOENT/ENOTDIR completely unwrapped", async () => {
  const inspect = inspectSequence(shape(), shape());
  const boom = fsCode("EACCES");
  const fs = fakeFs({ unlinkError: boom });
  await assert.rejects(
    () => removeOwnedMutex({
      inspect,
      allow: () => true,
      fs,
      noun: NOUN,
      onRemoved: neverOnRemoved,
      onRmdirError: neverOnRmdirError,
    }),
    (error) => error === boom,
  );
});

test("removeOwnedMutex refuses gracefully when the post-unlink stat reports ENOENT", async () => {
  const inspect = inspectSequence(shape(), shape());
  const fs = fakeFs({ statError: fsCode("ENOENT") });
  const result = await removeOwnedMutex({
    inspect,
    allow: () => true,
    fs,
    noun: NOUN,
    onRemoved: neverOnRemoved,
    onRmdirError: neverOnRmdirError,
  });
  assert.deepEqual(result, { refused: true, reason: `the ${NOUN} directory disappeared before removal` });
  assert.equal(fs.calls.unlink.length, 1, "the marker must already have been unlinked before this refusal");
  assert.equal(fs.calls.rmdir.length, 0);
});

test("removeOwnedMutex refuses gracefully when the post-unlink stat reports ENOTDIR", async () => {
  const inspect = inspectSequence(shape(), shape());
  const fs = fakeFs({ statError: fsCode("ENOTDIR") });
  const result = await removeOwnedMutex({
    inspect,
    allow: () => true,
    fs,
    noun: NOUN,
    onRemoved: neverOnRemoved,
    onRmdirError: neverOnRmdirError,
  });
  assert.deepEqual(result, { refused: true, reason: `the ${NOUN} directory disappeared before removal` });
});

test("removeOwnedMutex rethrows a post-unlink stat error that is not ENOENT/ENOTDIR completely unwrapped", async () => {
  const inspect = inspectSequence(shape(), shape());
  const boom = fsCode("EIO");
  const fs = fakeFs({ statError: boom });
  await assert.rejects(
    () => removeOwnedMutex({
      inspect,
      allow: () => true,
      fs,
      noun: NOUN,
      onRemoved: neverOnRemoved,
      onRmdirError: neverOnRmdirError,
    }),
    (error) => error === boom,
  );
});

test("removeOwnedMutex refuses when the post-unlink stat says the path is no longer a directory", async () => {
  const inspect = inspectSequence(shape(), shape());
  const fs = fakeFs({ postUnlinkStat: { isDirectory: () => false, ...DIR_A } });
  const result = await removeOwnedMutex({
    inspect,
    allow: () => true,
    fs,
    noun: NOUN,
    onRemoved: neverOnRemoved,
    onRmdirError: neverOnRmdirError,
  });
  assert.deepEqual(result, { refused: true, reason: `the ${NOUN} directory was replaced before removal` });
  assert.equal(fs.calls.rmdir.length, 0);
});

test("removeOwnedMutex refuses when the post-unlink stat's identity no longer matches the recheck", async () => {
  const inspect = inspectSequence(shape({ dirStat: DIR_A }), shape({ dirStat: DIR_A }));
  const fs = fakeFs({ postUnlinkStat: { isDirectory: () => true, ...DIR_B } });
  const result = await removeOwnedMutex({
    inspect,
    allow: () => true,
    fs,
    noun: NOUN,
    onRemoved: neverOnRemoved,
    onRmdirError: neverOnRmdirError,
  });
  assert.deepEqual(result, { refused: true, reason: `the ${NOUN} directory was replaced before removal` });
  assert.equal(fs.calls.rmdir.length, 0);
});

test("removeOwnedMutex calls onRmdirError on an rmdir anomaly and propagates whatever it throws", async () => {
  const inspect = inspectSequence(shape(), shape());
  const rmdirError = fsCode("ENOTEMPTY");
  const fs = fakeFs({ rmdirError });
  const custom = new Error("store-specific wrapped error");
  let seenError;
  let seenRecheck;
  await assert.rejects(
    () => removeOwnedMutex({
      inspect,
      allow: () => true,
      fs,
      noun: NOUN,
      onRemoved: neverOnRemoved,
      onRmdirError: (error, recheck) => {
        seenError = error;
        seenRecheck = recheck;
        throw custom;
      },
    }),
    (error) => error === custom,
  );
  assert.equal(seenError, rmdirError);
  assert.equal(seenRecheck.markerPath, shape().markerPath);
});

test("removeOwnedMutex falls back to rethrowing the raw rmdir error if onRmdirError does not throw", async () => {
  const inspect = inspectSequence(shape(), shape());
  const rmdirError = fsCode("ENOTEMPTY");
  const fs = fakeFs({ rmdirError });
  await assert.rejects(
    () => removeOwnedMutex({
      inspect,
      allow: () => true,
      fs,
      noun: NOUN,
      onRemoved: neverOnRemoved,
      onRmdirError: () => {}, // misbehaving: does not throw
    }),
    (error) => error === rmdirError,
  );
});

test("removeOwnedMutex succeeds end to end: unlinks the marker, rmdirs the directory, and returns onRemoved's shape", async () => {
  const initial = shape();
  const inspect = inspectSequence(initial, initial);
  const fs = fakeFs();
  const result = await removeOwnedMutex({
    inspect,
    allow: (marker) => {
      assert.equal(marker, initial.marker);
      return true;
    },
    fs,
    noun: NOUN,
    onRemoved: (recheck) => ({ removed: true, markerPath: recheck.markerPath, dirPath: recheck.dirPath }),
    onRmdirError: neverOnRmdirError,
  });
  assert.deepEqual(result, { removed: true, markerPath: initial.markerPath, dirPath: initial.dirPath });
  assert.deepEqual(fs.calls.unlink, [initial.markerPath]);
  assert.deepEqual(fs.calls.stat, [initial.dirPath]);
  assert.deepEqual(fs.calls.rmdir, [initial.dirPath]);
  assert.equal(inspect.calls.length, 2, "exactly two inspects: the initial look and the pre-unlink recheck");
});

test("removeOwnedMutex operates on the recheck's paths, not the initial inspect's, once both are available", async () => {
  // A store's inspect() always resolves the same underlying directory/marker on both calls in
  // real usage, so recheck.markerPath === initial.markerPath in practice -- but this function
  // must be reading from `recheck` for the unlink/stat/rmdir targets, not `initial`, since
  // `initial` is only ever used for the two step-1/step-4 comparisons. Give them different
  // (but otherwise consistent) values to prove which one is actually used.
  const initial = shape({ markerPath: "/initial/owner.json", dirPath: "/initial" });
  const recheck = shape({ markerPath: "/initial/owner.json", dirPath: "/initial", entries: ["owner.json"] });
  // markerPath/markerText must match between initial and recheck to pass the change-detection
  // guard; only dirPath differs, simulating nothing meaningful -- this test only asserts *which*
  // object's fields feed the fs calls, using recheck's dirPath as the distinguishing marker.
  recheck.dirPath = "/recheck";
  const inspect = inspectSequence(initial, recheck);
  const fs = fakeFs();
  await removeOwnedMutex({
    inspect,
    allow: () => true,
    fs,
    noun: NOUN,
    onRemoved: () => ({ removed: true }),
    onRmdirError: neverOnRmdirError,
  });
  assert.deepEqual(fs.calls.stat, ["/recheck"]);
  assert.deepEqual(fs.calls.rmdir, ["/recheck"]);
});
