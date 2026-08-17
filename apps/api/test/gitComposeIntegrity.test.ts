import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  GitComposeSourceIntegrityError,
  gitComposeCheckoutCleanGuardCommands,
  inspectGitComposeSourceIntegrity
} from "../src/services/gitComposeIntegrity.js";

describe("qualified Git Compose source integrity", () => {
  it("binds literal checkout-contained build and file inputs", () => {
    expect(inspectGitComposeSourceIntegrity(
      [
        "services:",
        "  app:",
        "    build:",
        "      context: ../app",
        "      dockerfile: docker/Dockerfile",
        "    env_file:",
        "      - path: ../config/runtime.env",
        "    label_file: ../config/labels",
        "    credential_spec:",
        "      file: ../config/credential.json",
        "configs:",
        "  settings:",
        "    file: ../config/settings.json",
        "secrets:",
        "  token:",
        "    file: ../config/token"
      ].join("\n"),
      "deploy/compose.yaml"
    )).toEqual({
      composePath: "deploy/compose.yaml",
      buildContexts: ["app"],
      referencedFiles: [
        "app/docker/Dockerfile",
        "config/credential.json",
        "config/labels",
        "config/runtime.env",
        "config/settings.json",
        "config/token",
        "deploy/compose.yaml"
      ],
      runtimePaths: []
    });
  });

  it("records distinct short and merge-key long-syntax relative runtime binds", () => {
    const integrity = inspectGitComposeSourceIntegrity(
      [
        "x-runtime: &runtime",
        "  type: bind",
        "  source: ../state/cache",
        "  target: /var/cache/app",
        "services:",
        "  app:",
        "    image: nginx",
        "    volumes:",
        "      - ../state/uploads:/srv/uploads",
        "      - <<: *runtime",
        "      - named-data:/srv/named",
        "      - /var/lib/app:/srv/absolute",
        "      - type: bind",
        "        source: /srv/managed/app",
        "        target: /srv/long-absolute",
        "volumes:",
        "  named-data: {}"
      ].join("\n"),
      "deploy/compose.yaml",
      ["deploy/compose.yaml"]
    );

    expect(integrity.runtimePaths).toEqual([
      "state/cache",
      "state/uploads"
    ]);
  });

  it.each([
    [
      "the Compose source file",
      "services:\n  app:\n    image: nginx\n    volumes:\n      - ./:/app"
    ],
    [
      "a referenced source file",
      "services:\n  app:\n    image: nginx\n    env_file: ./runtime/config.env\n    volumes:\n      - ./runtime:/runtime"
    ],
    [
      "the default build context",
      "services:\n  app:\n    build: .\n    volumes:\n      - ./runtime:/runtime"
    ],
    [
      "a nested build context",
      "services:\n  app:\n    build: ./src\n    volumes:\n      - ./src/cache:/cache"
    ]
  ])("rejects a relative runtime bind that overlaps %s", (_name, yaml) => {
    expect(() =>
      inspectGitComposeSourceIntegrity(yaml, "compose.yaml")
    ).toThrow(/overlaps (?:qualified source file|build context)/);
  });

  it("rejects a runtime bind that contains a tracked path", () => {
    expect(() =>
      inspectGitComposeSourceIntegrity(
        "services:\n  app:\n    image: nginx\n    volumes:\n      - ./runtime:/runtime\n",
        "compose.yaml",
        ["compose.yaml", "runtime/.keep"]
      )
    ).toThrow("overlaps tracked path 'runtime/.keep'");
  });

  it.each([
    [
      "escaping short syntax",
      "services:\n  app:\n    image: nginx\n    volumes:\n      - ../../outside:/outside"
    ],
    [
      "escaping long syntax",
      "services:\n  app:\n    image: nginx\n    volumes:\n      - type: bind\n        source: ../../outside\n        target: /outside"
    ],
    [
      "interpolated short syntax",
      "services:\n  app:\n    image: nginx\n    volumes:\n      - ${RUNTIME_PATH}:/runtime"
    ],
    [
      "interpolated long syntax",
      "services:\n  app:\n    image: nginx\n    volumes:\n      - type: bind\n        source: $RUNTIME_PATH\n        target: /runtime"
    ]
  ])("rejects %s runtime bind sources", (_name, yaml) => {
    expect(() =>
      inspectGitComposeSourceIntegrity(yaml, "deploy/compose.yaml")
    ).toThrow(GitComposeSourceIntegrityError);
  });

  it("validates runtime paths before excluding only their literal trees from status", () => {
    const integrity = inspectGitComposeSourceIntegrity(
      "services:\n  app:\n    image: nginx\n    volumes:\n      - ./runtime data:/runtime\n",
      "deploy/compose.yaml"
    );
    const commands = gitComposeCheckoutCleanGuardCommands(
      "/srv/app",
      integrity
    );
    const joined = commands.join(" && ");

    expect(integrity.runtimePaths).toEqual(["deploy/runtime data"]);
    expect(joined).toContain(
      "git --literal-pathspecs ls-files -- 'deploy/runtime data'"
    );
    expect(joined).toContain("test ! -L '/srv/app/deploy/runtime data'");
    expect(joined).toContain('runtime_real=$(realpath "$runtime_probe")');
    expect(joined).toContain(
      "git status --porcelain=v1 --untracked-files=all --ignored=matching -- . ':(exclude,literal)deploy/runtime data'"
    );
    expect(joined.indexOf("git --literal-pathspecs ls-files")).toBeLessThan(
      joined.indexOf("git status --porcelain")
    );
  });

  it("allows generated untracked bind data but rejects tracked or symlinked runtime paths", () => {
    const checkout = mkdtempSync(path.join(os.tmpdir(), "composebastion-bind-guard-"));
    const composeYaml = [
      "services:",
      "  app:",
      "    image: nginx",
      "    volumes:",
      "      - ./runtime:/runtime"
    ].join("\n");
    const run = (command: string, args: string[] = []) =>
      execFileSync(command, args, { cwd: checkout, stdio: "pipe" });

    try {
      run("git", ["init", "--quiet"]);
      writeFileSync(path.join(checkout, "compose.yaml"), composeYaml);
      run("git", ["add", "compose.yaml"]);
      run("git", [
        "-c",
        "user.name=ComposeBastion Test",
        "-c",
        "user.email=composebastion@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "fixture"
      ]);
      const integrity = inspectGitComposeSourceIntegrity(
        composeYaml,
        "compose.yaml"
      );
      const guard = gitComposeCheckoutCleanGuardCommands(
        checkout,
        integrity
      ).join(" && ");

      mkdirSync(path.join(checkout, "runtime"));
      writeFileSync(path.join(checkout, "runtime", "generated.db"), "runtime");
      expect(() => run("/bin/sh", ["-c", guard])).not.toThrow();

      rmSync(path.join(checkout, "runtime"), { recursive: true });
      symlinkSync(os.tmpdir(), path.join(checkout, "runtime"));
      expect(() => run("/bin/sh", ["-c", guard])).toThrow();

      rmSync(path.join(checkout, "runtime"));
      mkdirSync(path.join(checkout, "runtime"));
      writeFileSync(path.join(checkout, "runtime", ".keep"), "tracked");
      run("git", ["add", "runtime/.keep"]);
      run("git", [
        "-c",
        "user.name=ComposeBastion Test",
        "-c",
        "user.email=composebastion@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "tracked runtime"
      ]);
      expect(() => run("/bin/sh", ["-c", guard])).toThrow();
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "include",
      "include:\n  - /tmp/outside.yaml\nservices:\n  app:\n    image: nginx"
    ],
    [
      "extends",
      "services:\n  app:\n    extends:\n      file: ../outside.yaml\n      service: app"
    ],
    [
      "provider",
      "services:\n  app:\n    provider:\n      type: external"
    ],
    [
      "remote build context",
      "services:\n  app:\n    build: https://example.test/source.tar.gz"
    ],
    [
      "escaping environment file",
      "services:\n  app:\n    image: nginx\n    env_file: ../../outside.env"
    ],
    [
      "interpolated config file",
      "services:\n  app:\n    image: nginx\nconfigs:\n  app:\n    file: ${CONFIG_PATH}"
    ],
    [
      "additional build context",
      "services:\n  app:\n    build:\n      context: .\n      additional_contexts:\n        assets: ../assets"
    ],
    [
      "merge-key-hidden external input",
      "x-base: &base\n  env_file:\n    - /absolute/outside.env\nservices:\n  app:\n    <<: *base\n    image: nginx"
    ]
  ])("rejects %s indirection", (_name, yaml) => {
    expect(() =>
      inspectGitComposeSourceIntegrity(yaml, "compose.yaml")
    ).toThrow(GitComposeSourceIntegrityError);
  });

  it("rejects an absolute or escaping primary Compose path", () => {
    expect(() =>
      inspectGitComposeSourceIntegrity("services:\n  app:\n    image: nginx\n", "/tmp/compose.yaml")
    ).toThrow("cannot be absolute");
    expect(() =>
      inspectGitComposeSourceIntegrity("services:\n  app:\n    image: nginx\n", "../compose.yaml")
    ).toThrow("cannot escape");
  });
});
