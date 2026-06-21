type ShellToken =
  | { type: "word"; value: string }
  | { type: "op"; value: string };

export type ParsedDockerCommand = {
  args: string[];
  cwd?: string;
  env?: { DOCKER_HOST?: string };
  stdin?: string;
};

function isWhitespace(char: string) {
  return /\s/.test(char);
}

function isOperatorStart(char: string) {
  return [";", "|", "&", "<", ">", "(", ")"].includes(char);
}

function isWordToken(token: ShellToken): token is Extract<ShellToken, { type: "word" }> {
  return token.type === "word";
}

function tokenize(command: string): ShellToken[] | null {
  const tokens: ShellToken[] = [];
  let index = 0;

  while (index < command.length) {
    while (index < command.length && isWhitespace(command[index]!)) index += 1;
    if (index >= command.length) break;

    const char = command[index]!;
    if (isOperatorStart(char)) {
      if (char === "&" && command[index + 1] === "&") {
        tokens.push({ type: "op", value: "&&" });
        index += 2;
      } else if (char === "|" && command[index + 1] === "|") {
        tokens.push({ type: "op", value: "||" });
        index += 2;
      } else {
        tokens.push({ type: "op", value: char });
        index += 1;
      }
      continue;
    }

    let value = "";
    while (index < command.length && !isWhitespace(command[index]!) && !isOperatorStart(command[index]!)) {
      const current = command[index]!;
      if (current === "'") {
        index += 1;
        const end = command.indexOf("'", index);
        if (end === -1) return null;
        value += command.slice(index, end);
        index = end + 1;
        continue;
      }
      if (current === "\"") {
        index += 1;
        while (index < command.length && command[index] !== "\"") {
          if (command[index] === "`" || (command[index] === "$" && command[index + 1] === "(")) return null;
          if (command[index] === "\\" && index + 1 < command.length) {
            value += command[index + 1]!;
            index += 2;
          } else {
            value += command[index]!;
            index += 1;
          }
        }
        if (command[index] !== "\"") return null;
        index += 1;
        continue;
      }
      if (current === "`" || (current === "$" && command[index + 1] === "(")) return null;
      if (current === "\\" && index + 1 < command.length) {
        value += command[index + 1]!;
        index += 2;
        continue;
      }
      value += current;
      index += 1;
    }

    if (!value) return null;
    tokens.push({ type: "word", value });
  }

  return tokens;
}

function wordsOnly(tokens: ShellToken[]) {
  return tokens.every(isWordToken) ? tokens.map((token) => token.value) : null;
}

function parseDockerInvocation(tokens: ShellToken[], cwd?: string): ParsedDockerCommand | null {
  let remaining = tokens;
  const env: ParsedDockerCommand["env"] = {};
  const first = remaining[0];
  if (first?.type === "word" && first.value.startsWith("DOCKER_HOST=")) {
    const dockerHost = first.value.slice("DOCKER_HOST=".length);
    if (!dockerHost) return null;
    env.DOCKER_HOST = dockerHost;
    remaining = remaining.slice(1);
  }

  const words = wordsOnly(remaining);
  if (!words || words[0] !== "docker" || words.length < 2) return null;
  const parsed: ParsedDockerCommand = { args: words.slice(1) };
  if (cwd) parsed.cwd = cwd;
  if (env.DOCKER_HOST) parsed.env = env;
  return parsed;
}

function parseDockerLoginPipe(tokens: ShellToken[], cwd?: string): ParsedDockerCommand | null {
  if (
    tokens[0]?.type !== "word" || tokens[0].value !== "printf" ||
    tokens[1]?.type !== "word" || tokens[1].value !== "%s" ||
    tokens[2]?.type !== "word" ||
    tokens[3]?.type !== "op" || tokens[3].value !== "|" ||
    tokens[4]?.type !== "word" || tokens[4].value !== "docker"
  ) {
    return null;
  }
  const words = wordsOnly(tokens.slice(4));
  if (!words || words[0] !== "docker" || words[1] !== "login" || !words.includes("--password-stdin")) return null;
  const parsed: ParsedDockerCommand = { args: words.slice(1), stdin: tokens[2].value };
  if (cwd) parsed.cwd = cwd;
  return parsed;
}

export function parsePermittedDockerCommand(command: string): ParsedDockerCommand | null {
  const tokens = tokenize(command.trim());
  if (!tokens?.length) return null;

  let remaining = tokens;
  let cwd: string | undefined;
  if (
    remaining[0]?.type === "word" && remaining[0].value === "cd" &&
    remaining[1]?.type === "word" &&
    remaining[2]?.type === "op" && remaining[2].value === "&&"
  ) {
    cwd = remaining[1].value;
    if (!cwd) return null;
    remaining = remaining.slice(3);
  }

  return parseDockerLoginPipe(remaining, cwd) ?? parseDockerInvocation(remaining, cwd);
}

export function isPermittedDockerCommand(command: string) {
  return parsePermittedDockerCommand(command) !== null;
}
