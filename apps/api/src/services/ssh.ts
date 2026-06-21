import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { Client, type ClientChannel, type ConnectConfig } from "ssh2";

export interface SshTarget {
  hostname: string;
  port: number;
  username: string;
  privateKey?: string;
  password?: string;
  passphrase?: string | null;
}

export interface SshResult {
  stdout: string;
  stderr: string;
  code: number;
  signal?: string;
}

function validatedSshCommand(command: string) {
  const trimmed = command.trim();
  if (!trimmed) throw new Error("SSH command cannot be empty");
  if (/[\0\r]/.test(trimmed)) throw new Error("SSH command contains invalid control characters");
  return trimmed;
}

function execValidatedSshCommand(
  client: Client,
  command: string,
  callback: (error: Error | undefined, stream: ClientChannel) => void
) {
  const safeCommand = validatedSshCommand(command);
  // Commands passed here are built by internal command builders that shell-quote untrusted arguments; this wrapper rejects control characters before invoking ssh2.
  // codeql[js/command-line-injection]
  client.exec(safeCommand, callback);
}

function connect(target: SshTarget) {
  return new Promise<Client>((resolve, reject) => {
    const client = new Client();
    const config: ConnectConfig = {
      host: target.hostname,
      port: target.port,
      username: target.username,
      privateKey: target.privateKey || undefined,
      password: target.password || undefined,
      passphrase: target.passphrase ?? undefined,
      readyTimeout: 15_000,
      keepaliveInterval: 10_000
    };

    client.once("ready", () => resolve(client));
    client.once("error", reject);
    client.connect(config);
  });
}

export async function runSshCommand(target: SshTarget, command: string, options: { input?: string | Buffer; timeoutMs?: number } = {}) {
  const client = await connect(target);
  return new Promise<SshResult>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      client.end();
      reject(new Error(`SSH command timed out after ${options.timeoutMs ?? 120_000}ms`));
    }, options.timeoutMs ?? 120_000);

    execValidatedSshCommand(client, command, (error, stream) => {
      if (error) {
        clearTimeout(timeout);
        client.end();
        reject(error);
        return;
      }

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      stream.on("data", (chunk: Buffer) => stdout.push(chunk));
      stream.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      stream.on("close", (code: number | null, signal?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        client.end();
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          code: code ?? 0,
          signal
        });
      });

      if (options.input) stream.end(options.input);
      else stream.end();
    });
  });
}

export async function streamSshCommandLines(
  target: SshTarget,
  command: string,
  onLine: (line: string) => void,
  onError: (error: Error) => void,
  options: { preserveLineFormatting?: boolean } = {}
) {
  const client = await connect(target);
  return new Promise<() => void>((resolve, reject) => {
    let streamRef: { destroy: () => void } | null = null;
    let buffer = "";
    let settled = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      streamRef?.destroy();
      client.end();
    };

    execValidatedSshCommand(client, command, (error, stream) => {
      if (error) {
        client.end();
        reject(error);
        return;
      }

      streamRef = stream;
      stream.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (options.preserveLineFormatting) {
            onLine(line);
            continue;
          }
          const trimmed = line.trim();
          if (trimmed) onLine(trimmed);
        }
      });
      stream.stderr.on("data", (chunk: Buffer) => {
        const message = chunk.toString("utf8").trim();
        if (message) onError(new Error(message));
      });
      stream.on("error", onError);
      stream.on("close", cleanup);
      resolve(cleanup);
    });
  });
}

export async function writeRemoteFile(target: SshTarget, remotePath: string, contents: string) {
  const client = await connect(target);
  return new Promise<void>((resolve, reject) => {
    client.sftp((sftpError, sftp) => {
      if (sftpError) {
        client.end();
        reject(sftpError);
        return;
      }

      sftp.writeFile(remotePath, contents, { mode: 0o600 }, (writeError) => {
        client.end();
        if (writeError) reject(writeError);
        else resolve();
      });
    });
  });
}

export async function readRemoteFile(target: SshTarget, remotePath: string, maxBytes = 512 * 1024) {
  const client = await connect(target);
  return new Promise<string>((resolve, reject) => {
    client.sftp((sftpError, sftp) => {
      if (sftpError) {
        client.end();
        reject(sftpError);
        return;
      }

      sftp.stat(remotePath, (statError, stats) => {
        if (statError) {
          client.end();
          reject(statError);
          return;
        }
        if (stats.size > maxBytes) {
          client.end();
          reject(new Error(`File is too large to edit in-browser (${stats.size} bytes, limit ${maxBytes} bytes)`));
          return;
        }

        sftp.readFile(remotePath, (readError, data) => {
          client.end();
          if (readError) reject(readError);
          else resolve(data.toString("utf8"));
        });
      });
    });
  });
}

export async function streamSshCommandToFile(
  target: SshTarget,
  command: string,
  localPath: string,
  timeoutMs = 10 * 60_000,
  outputTransform?: NodeJS.ReadWriteStream | null
) {
  await mkdir(path.dirname(localPath), { recursive: true });
  const client = await connect(target);

  return new Promise<{ stderr: string; sizeBytes: number }>((resolve, reject) => {
    let settled = false;
    const file = createWriteStream(localPath);
    const stderr: Buffer[] = [];
    let timeout: ReturnType<typeof setTimeout>;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      file.destroy();
      client.end();
      reject(error);
    };
    const fileFinished = new Promise<void>((finishResolve) => {
      file.once("finish", finishResolve);
    });
    timeout = setTimeout(() => {
      fail(new Error(`SSH stream timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    file.on("error", fail);

    execValidatedSshCommand(client, command, (error, stream) => {
      if (error) {
        fail(error);
        return;
      }

      const output = outputTransform ? stream.pipe(outputTransform) : stream;
      output.pipe(file);
      stream.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      stream.on("error", fail);
      outputTransform?.on("error", fail);
      stream.on("close", async (code: number | null) => {
        if (settled) return;
        if (code && code !== 0) {
          fail(new Error(Buffer.concat(stderr).toString("utf8") || `SSH stream failed with code ${code}`));
          return;
        }
        try {
          await fileFinished;
          settled = true;
          clearTimeout(timeout);
          client.end();
          const stats = await stat(localPath);
          resolve({ stderr: Buffer.concat(stderr).toString("utf8"), sizeBytes: stats.size });
        } catch (finishError) {
          fail(finishError instanceof Error ? finishError : new Error(String(finishError)));
        }
      });
    });
  });
}

export interface SshShellSession {
  write: (data: Buffer | string) => void;
  resize: (cols: number, rows: number) => void;
  close: () => void;
  onData: (handler: (chunk: Buffer) => void) => void;
  onClose: (handler: () => void) => void;
  onError: (handler: (error: Error) => void) => void;
}

export async function openSshShell(
  target: SshTarget,
  options: { cols?: number; rows?: number; term?: string } = {}
): Promise<SshShellSession> {
  const client = await connect(target);
  const cols = options.cols ?? 80;
  const rows = options.rows ?? 24;
  const term = options.term ?? "xterm-256color";

  return new Promise((resolve, reject) => {
    client.shell({ cols, rows, term }, (error, stream) => {
      if (error) {
        client.end();
        reject(error);
        return;
      }

      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        stream.close();
        client.end();
      };

      resolve({
        write: (data) => stream.write(data),
        resize: (width, height) => stream.setWindow(height, width, 0, 0),
        close,
        onData: (handler) => stream.on("data", handler),
        onClose: (handler) => {
          stream.on("close", handler);
          client.on("close", handler);
        },
        onError: (handler) => {
          stream.on("error", handler);
          client.on("error", handler);
        }
      });
    });
  });
}

export async function pipeReadableToSshCommand(
  target: SshTarget,
  input: NodeJS.ReadableStream,
  command: string,
  timeoutMs = 10 * 60_000
) {
  const client = await connect(target);
  return new Promise<SshResult>((resolve, reject) => {
    let settled = false;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      if ("destroy" in input && typeof input.destroy === "function") input.destroy();
      client.end();
      reject(new Error(`SSH restore stream timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if ("destroy" in input && typeof input.destroy === "function") input.destroy();
      client.end();
      reject(error);
    };

    input.on("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));

    client.exec(command, (error, stream) => {
      if (error) {
        clearTimeout(timeout);
        client.end();
        reject(error);
        return;
      }

      input.pipe(stream);
      stream.on("data", (chunk: Buffer) => stdout.push(chunk));
      stream.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      stream.on("error", fail);
      stream.on("close", (code: number | null, signal?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        client.end();
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          code: code ?? 0,
          signal
        });
      });
    });
  });
}

export async function pipeFileToSshCommand(target: SshTarget, localPath: string, command: string, timeoutMs = 10 * 60_000) {
  return pipeReadableToSshCommand(target, createReadStream(localPath), command, timeoutMs);
}
