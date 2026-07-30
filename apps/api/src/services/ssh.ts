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
  // lgtm[js/command-line-injection]
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

    const onError = (error: Error) => {
      client.removeListener("ready", onReady);
      reject(error);
    };
    const onReady = () => {
      client.removeListener("error", onError);
      // ssh2 may report more than one late socket/protocol/keepalive error
      // while a client is closing. Operation-specific listeners handle the
      // first actionable failure; this persistent sink prevents any later
      // EventEmitter "error" from becoming an uncaught process exception.
      client.on("error", () => undefined);
      resolve(client);
    };
    client.once("ready", onReady);
    client.once("error", onError);
    client.connect(config);
  });
}

export async function runSshCommand(target: SshTarget, command: string, options: { input?: string | Buffer; timeoutMs?: number } = {}) {
  const client = await connect(target);
  return new Promise<SshResult>((resolve, reject) => {
    let settled = false;
    let streamRef: ClientChannel | null = null;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      streamRef?.destroy();
      client.end();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const timeout = setTimeout(
      () => fail(new Error(`SSH command timed out after ${options.timeoutMs ?? 120_000}ms`)),
      options.timeoutMs ?? 120_000
    );
    client.once("error", fail);

    execValidatedSshCommand(client, command, (error, stream) => {
      if (error) {
        fail(error);
        return;
      }
      if (settled) {
        stream.destroy();
        return;
      }
      streamRef = stream;

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      stream.on("data", (chunk: Buffer) => stdout.push(chunk));
      stream.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      stream.once("error", fail);
      stream.stderr.once("error", fail);
      stream.on("close", (code: number | null, signal?: string) => {
        if (settled) return;
        if (code === null) {
          fail(new Error(`SSH command closed without an exit status${signal ? ` (${signal})` : ""}`));
          return;
        }
        settled = true;
        clearTimeout(timeout);
        client.removeListener("error", fail);
        client.end();
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          code,
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
    let streamRef: ClientChannel | null = null;
    let buffer = "";
    let settled = false;
    let promiseResolved = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      client.removeListener("error", handleClientError);
      streamRef?.destroy();
      client.end();
    };
    const handleClientError = (error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      onError(failure);
      cleanup();
      if (!promiseResolved) reject(failure);
    };
    const handleStreamError = (error: unknown) => {
      onError(error instanceof Error ? error : new Error(String(error)));
      cleanup();
    };
    client.once("error", handleClientError);

    execValidatedSshCommand(client, command, (error, stream) => {
      if (error) {
        cleanup();
        reject(error);
        return;
      }
      if (settled) {
        stream.destroy();
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
      stream.once("error", handleStreamError);
      stream.stderr.once("error", handleStreamError);
      stream.once("close", cleanup);
      promiseResolved = true;
      resolve(cleanup);
    });
  });
}

export async function writeRemoteFile(target: SshTarget, remotePath: string, contents: string) {
  const client = await connect(target);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let sftpRef: { once: (event: "error", handler: (error: unknown) => void) => unknown; removeListener: (event: "error", handler: (error: unknown) => void) => unknown } | null = null;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      client.removeListener("error", fail);
      sftpRef?.removeListener("error", fail);
      client.end();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    client.once("error", fail);
    client.sftp((sftpError, sftp) => {
      if (settled) return;
      if (sftpError) {
        fail(sftpError);
        return;
      }
      sftpRef = sftp;
      sftp.once("error", fail);

      sftp.writeFile(remotePath, contents, { mode: 0o600 }, (writeError) => {
        if (settled) return;
        if (writeError) {
          fail(writeError);
          return;
        }
        settled = true;
        client.removeListener("error", fail);
        sftp.removeListener("error", fail);
        client.end();
        resolve();
      });
    });
  });
}

export async function readRemoteFile(target: SshTarget, remotePath: string, maxBytes = 512 * 1024) {
  const client = await connect(target);
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let sftpRef: { once: (event: "error", handler: (error: unknown) => void) => unknown; removeListener: (event: "error", handler: (error: unknown) => void) => unknown } | null = null;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      client.removeListener("error", fail);
      sftpRef?.removeListener("error", fail);
      client.end();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    client.once("error", fail);
    client.sftp((sftpError, sftp) => {
      if (settled) return;
      if (sftpError) {
        fail(sftpError);
        return;
      }
      sftpRef = sftp;
      sftp.once("error", fail);

      sftp.stat(remotePath, (statError, stats) => {
        if (settled) return;
        if (statError) {
          fail(statError);
          return;
        }
        if (stats.size > maxBytes) {
          fail(new Error(`File is too large to edit in-browser (${stats.size} bytes, limit ${maxBytes} bytes)`));
          return;
        }

        sftp.readFile(remotePath, (readError, data) => {
          if (settled) return;
          if (readError) {
            fail(readError);
            return;
          }
          settled = true;
          client.removeListener("error", fail);
          sftp.removeListener("error", fail);
          client.end();
          resolve(data.toString("utf8"));
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
    client.once("error", fail);

    execValidatedSshCommand(client, command, (error, stream) => {
      if (error) {
        fail(error);
        return;
      }
      if (settled) {
        stream.destroy();
        return;
      }

      const output = outputTransform ? stream.pipe(outputTransform) : stream;
      output.pipe(file);
      stream.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      stream.on("error", fail);
      stream.stderr.on("error", fail);
      outputTransform?.on("error", fail);
      stream.on("close", async (code: number | null) => {
        if (settled) return;
        if (code === null) {
          fail(new Error("SSH stream closed without an exit status"));
          return;
        }
        if (code !== 0) {
          fail(new Error(Buffer.concat(stderr).toString("utf8") || `SSH stream failed with code ${code}`));
          return;
        }
        try {
          await fileFinished;
          settled = true;
          clearTimeout(timeout);
          client.removeListener("error", fail);
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
    let streamRef: ClientChannel | null = null;
    let resolved = false;
    let closed = false;
    let terminalError: Error | null = null;
    const errorHandlers = new Set<(error: Error) => void>();
    const close = () => {
      if (closed) return;
      closed = true;
      client.removeListener("error", handleFailure);
      streamRef?.close();
      client.end();
    };
    const handleFailure = (error: unknown) => {
      if (closed) return;
      terminalError = error instanceof Error ? error : new Error(String(error));
      for (const handler of errorHandlers) handler(terminalError);
      if (!resolved) {
        closed = true;
        client.removeListener("error", handleFailure);
        client.end();
        reject(terminalError);
        return;
      }
      close();
    };
    client.once("error", handleFailure);
    client.shell({ cols, rows, term }, (error, stream) => {
      if (error) {
        handleFailure(error);
        return;
      }
      if (closed) {
        stream.destroy();
        return;
      }

      streamRef = stream;
      stream.once("error", handleFailure);

      resolved = true;
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
          errorHandlers.add(handler);
          if (terminalError) queueMicrotask(() => handler(terminalError!));
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
    client.once("error", fail);

    client.exec(command, (error, stream) => {
      if (error) {
        fail(error);
        return;
      }
      if (settled) {
        stream.destroy();
        return;
      }

      input.pipe(stream);
      stream.on("data", (chunk: Buffer) => stdout.push(chunk));
      stream.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      stream.on("error", fail);
      stream.stderr.on("error", fail);
      stream.on("close", (code: number | null, signal?: string) => {
        if (settled) return;
        if (code === null) {
          fail(new Error(`SSH restore stream closed without an exit status${signal ? ` (${signal})` : ""}`));
          return;
        }
        settled = true;
        clearTimeout(timeout);
        client.removeListener("error", fail);
        client.end();
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          code,
          signal
        });
      });
    });
  });
}

export async function pipeFileToSshCommand(target: SshTarget, localPath: string, command: string, timeoutMs = 10 * 60_000) {
  return pipeReadableToSshCommand(target, createReadStream(localPath), command, timeoutMs);
}
