import assert from "node:assert/strict";
import test from "node:test";
import {
  addLayerEntry,
  layerHidesTarget,
  normalizeLayerPath,
  resolveLayerTarget
} from "./oci-rootfs.mjs";

test("preserves POSIX backslashes instead of treating them as separators", () => {
  assert.equal(normalizeLayerPath("licenses\\LICENSE.md"), "licenses\\LICENSE.md");
  const entries = new Map([["licenses\\LICENSE.md", "licenses\\LICENSE.md"]]);
  assert.deepEqual(resolveLayerTarget(entries, "licenses/LICENSE.md"), {
    entry: null,
    whiteout: null
  });
});

test("rejects absolute and parent-traversing layer entries", () => {
  assert.throws(
    () => normalizeLayerPath("/licenses/LICENSE.md"),
    /must be relative POSIX paths/
  );
  assert.throws(
    () => normalizeLayerPath("licenses/../LICENSE.md"),
    /must not traverse parent directories/
  );
});

test("rejects duplicate normalized layer members", () => {
  const entries = new Map();
  addLayerEntry(entries, "./licenses/LICENSE.md");
  assert.throws(
    () => addLayerEntry(entries, "licenses/LICENSE.md"),
    /duplicate normalized member/
  );
});

test("detects a direct whiteout", () => {
  const entries = new Map([["licenses/.wh.LICENSE.md", "licenses/.wh.LICENSE.md"]]);
  assert.equal(layerHidesTarget(entries, "licenses/LICENSE.md"), "licenses/.wh.LICENSE.md");
});

test("detects an ancestor whiteout", () => {
  const entries = new Map([[".wh.licenses", ".wh.licenses"]]);
  assert.equal(layerHidesTarget(entries, "licenses/go-modules/manifest.json"), ".wh.licenses");
});

test("detects ancestor and root opaque whiteouts", () => {
  const ancestor = new Map([["licenses/.wh..wh..opq", "licenses/.wh..wh..opq"]]);
  const root = new Map([[".wh..wh..opq", ".wh..wh..opq"]]);
  assert.equal(
    layerHidesTarget(ancestor, "licenses/go-modules/manifest.json"),
    "licenses/.wh..wh..opq"
  );
  assert.equal(layerHidesTarget(root, "LICENSE.md"), ".wh..wh..opq");
});

test("a same-layer replacement wins over whiteout markers", () => {
  const entries = new Map([
    ["LICENSE.md", "./LICENSE.md"],
    [".wh.LICENSE.md", "./.wh.LICENSE.md"],
    [".wh..wh..opq", "./.wh..wh..opq"]
  ]);
  assert.deepEqual(resolveLayerTarget(entries, "LICENSE.md"), {
    entry: "./LICENSE.md",
    whiteout: null
  });
});
