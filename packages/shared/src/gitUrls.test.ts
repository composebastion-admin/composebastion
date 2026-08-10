import { describe, expect, it } from "vitest";
import {
  sanitizeGitRepositoryUrl,
  sanitizeGitRepositoryUrlFields,
  sanitizePlaintextHttpSourceUrl,
  sanitizeUrlDiagnosticText
} from "./gitUrls.js";

describe("URL diagnostic sanitization", () => {
  it("sanitizes supported schemes with zero, one, or multiple slash variants", () => {
    const separators = [
      "",
      "/",
      "//",
      "////",
      "\\",
      "\\\\",
      "\\\\\\\\"
    ];
    for (const scheme of ["http", "https", "ssh", "git"]) {
      for (const separator of separators) {
        const secret = `${scheme}-${separator.length}-slash-secret`;
        const input = `${scheme}:${separator}user:${secret}@host.test/path`;
        const expected = scheme === "ssh"
          ? "ssh://user@host.test/path"
          : `${scheme}://host.test/path`;
        expect(sanitizeUrlDiagnosticText(input), input).toBe(expected);
        expect(String(sanitizeUrlDiagnosticText(input)), input).not.toContain(secret);
      }
    }
  });

  it("sanitizes credentials in common infrastructure URL schemes", () => {
    for (const scheme of [
      "postgres",
      "postgresql",
      "redis",
      "rediss",
      "sftp",
      "ftp",
      "ftps",
      "mysql",
      "mariadb",
      "mongodb",
      "mongodb+srv",
      "amqp",
      "amqps",
      "smtp",
      "smtps",
      "nats"
    ]) {
      const secret = `${scheme}-diagnostic-secret`;
      const input = `Failed ${scheme}://service:${secret}@infra.example.test:5432/database?token=${secret}`;
      const sanitized = String(sanitizeUrlDiagnosticText(input));
      expect(sanitized, scheme).toBe(`Failed ${scheme}://infra.example.test:5432/database`);
      expect(sanitized, scheme).not.toContain(secret);
    }
  });

  it("sanitizes credential-bearing custom hierarchical schemes without treating prose labels as URLs", () => {
    const secret = "custom-scheme-secret";
    expect(sanitizeUrlDiagnosticText(
      `Connector: custom+driver://user:${secret}@connector.example.test/path#${secret}`
    )).toBe("Connector: custom+driver://connector.example.test/path");
    expect(sanitizeUrlDiagnosticText("Error: ordinary diagnostic text")).toBe(
      "Error: ordinary diagnostic text"
    );
  });

  it.each([
    ["single quote", "https://u:'single-quote-secret@h.test/p", "single-quote-secret"],
    ["double quote", "https://u:\"double-quote-secret@h.test/p", "double-quote-secret"],
    ["backtick", "https://u:`backtick-secret@h.test/p", "backtick-secret"],
    ["opening angle", "https://u:<opening-angle-secret@h.test/p", "opening-angle-secret"],
    ["closing angle", "https://u:>closing-angle-secret@h.test/p", "closing-angle-secret"],
    ["comma", "https://u:,comma-secret@h.test/p", "comma-secret"],
    ["semicolon", "https://u:;semicolon-secret@h.test/p", "semicolon-secret"]
  ])("keeps a %s delimiter inside the credential token", (_label, input, secret) => {
    const sanitized = String(sanitizeUrlDiagnosticText(input));
    expect(sanitized).toBe("https://h.test/p");
    expect(sanitized).not.toContain(secret);
  });

  it("sanitizes multiple adjacent URLs independently without leaking either credential", () => {
    const input = [
      "prefix ",
      "https:first:first-adjacent-secret@one.test/a,",
      "https:/second:second-adjacent-secret@two.test/b;",
      String.raw`ssh:\third:third-adjacent-secret@three.test/c`,
      " suffix"
    ].join("");
    const sanitized = String(sanitizeUrlDiagnosticText(input));

    expect(sanitized).toBe(
      "prefix https://one.test/a,https://two.test/b;ssh://third@three.test/c suffix"
    );
    expect(sanitized).not.toContain("first-adjacent-secret");
    expect(sanitized).not.toContain("second-adjacent-secret");
    expect(sanitized).not.toContain("third-adjacent-secret");
  });

  it("redacts complete malformed candidates while retaining trailing punctuation", () => {
    const cases = [
      ["Failed (https://?token=malformed-query-secret).", "Failed ([redacted-url])."],
      ["Failed https::::malformed-authority-secret;", "Failed [redacted-url];"],
      ["Failed `git:\\\\`; next", "Failed `[redacted-url]`; next"]
    ];
    for (const [input, expected] of cases) {
      const sanitized = String(sanitizeUrlDiagnosticText(input));
      expect(sanitized).toBe(expected);
      expect(sanitized).not.toContain("malformed-query-secret");
      expect(sanitized).not.toContain("malformed-authority-secret");
    }
  });

  it.each([
    ["query", "https://u:secret?part@host.test/path"],
    ["fragment", "https://u:secret#part@host.test/path"]
  ])("fails closed when an invalid %s promotes apparent userinfo", (_label, input) => {
    expect(sanitizeUrlDiagnosticText(input)).toBe("[redacted-url]");
    expect(String(sanitizeUrlDiagnosticText(input))).not.toContain("credential");
    expect(String(sanitizeUrlDiagnosticText(input))).not.toContain("secret");
  });

  it("preserves schema-valid @ path segments in structured fields and diagnostics", () => {
    const gitUrl = "https://git.example.test/team/@scope/repo.git";
    const composeUrl = "https://compose.example.test/configs/@prod/compose.yml";

    expect(sanitizeGitRepositoryUrl(gitUrl)).toBe(gitUrl);
    expect(sanitizePlaintextHttpSourceUrl(composeUrl)).toBe(composeUrl);
    expect(sanitizeGitRepositoryUrlFields({
      repositoryUrl: gitUrl,
      sourceLocator: composeUrl
    })).toEqual({
      repositoryUrl: gitUrl,
      sourceLocator: composeUrl
    });
    expect(sanitizeUrlDiagnosticText(`Git ${gitUrl}; Compose ${composeUrl}.`))
      .toBe(`Git ${gitUrl}; Compose ${composeUrl}.`);
  });

  it("uses URL-parser semantics for valid non-scoped @ paths and explicit ports", () => {
    const input = "https://git.example:8443/team/user@example/repo.git";

    expect(sanitizeGitRepositoryUrl(input)).toBe(input);
    expect(sanitizePlaintextHttpSourceUrl(input)).toBe(input);
    expect(sanitizeUrlDiagnosticText(input)).toBe(input);
    expect(sanitizeUrlDiagnosticText(String.raw`https://u:123\credential@host.test/path`))
      .toBe("https://u:123/credential@host.test/path");
  });

  it.each([
    ["ASCII space", " "],
    ["no-break space", "\u00a0"],
    ["U+2000 space", "\u2000"],
    ["multiple mixed spaces", " \u00a0 \u2000 "]
  ])("fails closed when %s occurs inside apparent URL userinfo", (_label, whitespace) => {
    const input = `prefix https://user:${whitespace}whitespace-secret@host.test/path suffix`;
    const sanitized = String(sanitizeUrlDiagnosticText(input));

    expect(sanitized).toBe("prefix [redacted-url] suffix");
    expect(sanitized).not.toContain("whitespace-secret");
    expect(sanitizeUrlDiagnosticText(sanitized)).toBe(sanitized);
  });

  it("bounds whitespace-userinfo redaction before the next URL", () => {
    const input = [
      "https://first: first-whitespace-secret@one.test/a ",
      "https://second:second-secret@two.test/b"
    ].join("");
    const sanitized = String(sanitizeUrlDiagnosticText(input));

    expect(sanitized).toBe("[redacted-url] https://two.test/b");
    expect(sanitized).not.toContain("first-whitespace-secret");
    expect(sanitized).not.toContain("second-secret");
    expect(sanitizeUrlDiagnosticText(sanitized)).toBe(sanitized);
  });

  it("does not split a nested supported-scheme token out of whitespace userinfo", () => {
    const sanitized = String(sanitizeUrlDiagnosticText(
      "https://u: pass-https:inner-secret@host.test/p"
    ));

    expect(sanitized).toBe("[redacted-url]");
    expect(sanitized).not.toContain("pass-https");
    expect(sanitized).not.toContain("inner-secret");
  });

  it("fails closed when whitespace continues apparent userinfo after a path delimiter", () => {
    const sanitized = String(sanitizeUrlDiagnosticText(
      "https://u:123/path promoted-whitespace-secret@host.test/p"
    ));

    expect(sanitized).toBe("[redacted-url]");
    expect(sanitized).not.toContain("promoted-whitespace-secret");
  });

  it.each([
    [
      "query",
      "https://host.test/path?token=query-prefix-secret query-suffix-secret"
    ],
    [
      "fragment",
      "https://host.test/path#fragment-prefix-secret fragment-suffix-secret"
    ]
  ])("fails closed when whitespace continues an already-started %s", (_label, input) => {
    const sanitized = String(sanitizeUrlDiagnosticText(input));

    expect(sanitized).toBe("[redacted-url]");
    expect(sanitized).not.toContain("prefix-secret");
    expect(sanitized).not.toContain("suffix-secret");
    expect(sanitizeUrlDiagnosticText(sanitized)).toBe(sanitized);
  });

  it("does not split a nested supported scheme out of a query continuation", () => {
    const sanitized = String(sanitizeUrlDiagnosticText(
      "https://host.test/p?token=query-prefix https:query-suffix-secret"
    ));

    expect(sanitized).toBe("[redacted-url]");
    expect(sanitized).not.toContain("query-prefix");
    expect(sanitized).not.toContain("query-suffix-secret");
  });

  it("consumes a query or fragment that starts after URL whitespace", () => {
    const query = String(sanitizeUrlDiagnosticText(
      "https://host.test/path ?token=query-continuation-secret"
    ));
    const fragment = String(sanitizeUrlDiagnosticText(
      "https://host.test/path #fragment-continuation-secret"
    ));

    expect(query).not.toContain("query-continuation-secret");
    expect(query).not.toContain("?token");
    expect(fragment).not.toContain("fragment-continuation-secret");
    expect(fragment).not.toContain("#fragment");
  });

  it("strips percent-encoded credential delimiters while preserving IPv6 hosts and ports", () => {
    const httpsInput =
      "https://u:percent-secret%2Fpart%3Fquery%23fragment@[2001:db8::1]:8443/path?token=query-secret";
    const sshInput =
      "ssh://git:ssh-secret%2Fpart@[2001:db8::2]:2222/team/repo.git#fragment-secret";

    expect(sanitizeUrlDiagnosticText(httpsInput))
      .toBe("https://[2001:db8::1]:8443/path");
    expect(sanitizePlaintextHttpSourceUrl(httpsInput))
      .toBe("https://[2001:db8::1]:8443/path");
    expect(sanitizeUrlDiagnosticText(sshInput))
      .toBe("ssh://git@[2001:db8::2]:2222/team/repo.git");
    expect(sanitizeGitRepositoryUrl(sshInput))
      .toBe("ssh://git@[2001:db8::2]:2222/team/repo.git");
    expect(JSON.stringify([
      sanitizeUrlDiagnosticText(httpsInput),
      sanitizeUrlDiagnosticText(sshInput)
    ])).not.toContain("secret");
  });

  it.each(["\r", "\n", "\t", "\u0000", "\u001f", "\u007f"])(
    "fails closed across an embedded ASCII control %#",
    (control) => {
      const input = `https://u:before-control${control}after-control@host.test/path`;
      const sanitized = String(sanitizeUrlDiagnosticText(input));

      expect(sanitized).toBe("[redacted-url]");
      expect(sanitized).not.toContain("before-control");
      expect(sanitized).not.toContain("after-control");
    }
  );

  it("is idempotent and leaves non-URL diagnostic text byte-for-byte intact", () => {
    const input = [
      "diagnostic-canary ",
      "(https://u:'idempotent-secret@h.test/p), ",
      "then https:/u:second-idempotent-secret@two.test/q."
    ].join("");
    const once = sanitizeUrlDiagnosticText(input);
    const twice = sanitizeUrlDiagnosticText(once);

    expect(once).toBe(
      "diagnostic-canary (https://h.test/p), then https://two.test/q."
    );
    expect(twice).toBe(once);
    expect(sanitizeUrlDiagnosticText("diagnostic-canary only")).toBe("diagnostic-canary only");
  });

  it("sanitizes dynamic object keys with deterministic collision-safe suffixes", () => {
    const secret = "dynamic-key-secret";
    const unsafeKey = `https://user:${secret}@keys.test/path`;
    const safeKey = "https://keys.test/path";
    const input = {
      nested: {
        [unsafeKey]: "first",
        [safeKey]: "second",
        malformed: {
          [`https://?token=${secret}`]: "third",
          "[redacted-url]": "fourth"
        }
      }
    };

    const sanitized = sanitizeGitRepositoryUrlFields(input);

    expect(sanitized).toEqual({
      nested: {
        [safeKey]: "first",
        [`${safeKey} [2]`]: "second",
        malformed: {
          "[redacted-url]": "third",
          "[redacted-url] [2]": "fourth"
        }
      }
    });
    expect(JSON.stringify(sanitized)).not.toContain(secret);
    expect(sanitizeGitRepositoryUrlFields(sanitized)).toEqual(sanitized);
  });

  it("preserves an own __proto__ diagnostic key without changing the output prototype", () => {
    const input = Object.fromEntries([["__proto__", "diagnostic-canary"]]);
    const sanitized = sanitizeGitRepositoryUrlFields(input);

    expect(Object.prototype.hasOwnProperty.call(sanitized, "__proto__")).toBe(true);
    expect(sanitized.__proto__).toBe("diagnostic-canary");
    expect(Object.getPrototypeOf(sanitized)).toBe(Object.prototype);
  });
});
