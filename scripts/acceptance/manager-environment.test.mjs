import assert from "node:assert/strict";
import test from "node:test";
import {
  hasManagedCanonicalDatabaseOverride,
  managedDatabaseTransitionComment
} from "./manager-environment.mjs";

test("recognizes a canonical managed override at trimmed end of output", () => {
  assert.equal(hasManagedCanonicalDatabaseOverride([
    "COMPOSEBASTION_VERSION=1.2.0-beta.1",
    managedDatabaseTransitionComment,
    "DATABASE_URL="
  ].join("\n")), true);
});

test("recognizes a canonical managed override with a trailing newline", () => {
  assert.equal(hasManagedCanonicalDatabaseOverride([
    managedDatabaseTransitionComment,
    "DATABASE_URL=",
    ""
  ].join("\n")), true);
});

test("rejects secret-bearing and unmarked database assignments", () => {
  assert.equal(hasManagedCanonicalDatabaseOverride([
    managedDatabaseTransitionComment,
    "DATABASE_URL=postgres://composebastion:secret@postgres:5432/composebastion"
  ].join("\n")), false);
  assert.equal(hasManagedCanonicalDatabaseOverride("DATABASE_URL="), false);
});
