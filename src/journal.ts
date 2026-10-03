import { constants } from "node:fs";
import {
  mkdir,
  open,
  lstat,
  chmod,
  readFile,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { hash } from "./state.js";
export interface JournalRecord {
  n: number;
  previous: string;
  data: unknown;
  hash: string;
}
export interface JournalOptions {
  maxPendingBytes?: number;
  maxBytes?: number;
  batchBytes?: number;
}
/** Single-writer append-only, bounded async queue. Failure never truncates earlier records. */
export class Journal {
  private queue: Buffer[] = [];
  private pending = 0;
  private total = 0;
  private handle?: FileHandle;
  private writing?: Promise<void>;
  private closed = false;
  failed = false;
  count = 0;
  digest = "0".repeat(64);
  readonly path: string;
  private constructor(
    private directory: string,
    id: string,
    private options: Required<JournalOptions>,
  ) {
    this.path = join(directory, id + ".frames");
  }
  static create(
    root: string,
    session: string,
    id: string,
    options: JournalOptions = {},
  ): Journal {
    if (
      !/^[a-zA-Z0-9_-]{1,128}$/.test(session) ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(id)
    )
      throw new Error("Unsafe journal identity");
    return new Journal(join(root, session), id, {
      maxPendingBytes: options.maxPendingBytes ?? 1048576,
      maxBytes: options.maxBytes ?? 33554432,
      batchBytes: options.batchBytes ?? 65536,
    });
  }
  append(data: unknown): boolean {
    if (this.closed || this.failed) return false;
    const body = { n: this.count, previous: this.digest, data };
    const digest = hash(body);
    const buffer = Buffer.from(
      JSON.stringify({ ...body, hash: digest }) + "\n",
    );
    if (
      this.pending + buffer.length > this.options.maxPendingBytes ||
      this.total + buffer.length > this.options.maxBytes
    ) {
      this.failed = true;
      return false;
    }
    this.digest = digest;
    this.count++;
    this.total += buffer.length;
    this.pending += buffer.length;
    this.queue.push(buffer);
    if (this.pending >= this.options.batchBytes) this.kick();
    return true;
  }
  flush(): void {
    if (!this.closed && !this.failed && this.queue.length) this.kick();
  }
  private kick(): void {
    if (this.writing) return;
    this.writing = this.drain()
      .catch(() => {
        this.failed = true;
        this.queue = [];
        this.pending = 0;
      })
      .finally(() => {
        this.writing = undefined;
      });
  }
  private async drain(): Promise<void> {
    if (!this.handle) {
      const root = dirname(this.directory);
      await mkdir(root, { recursive: true, mode: 0o700 });
      const parent = await lstat(root);
      if (!parent.isDirectory() || parent.isSymbolicLink())
        throw new Error("Unsafe journal root");
      await chmod(root, 0o700);
      await mkdir(this.directory, { recursive: false, mode: 0o700 }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        },
      );
      const stat = await lstat(this.directory);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Unsafe journal directory");
      await chmod(this.directory, 0o700);
      this.handle = await open(
        this.path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    }
    while (this.queue.length) {
      const batch = this.queue.splice(0);
      const data = Buffer.concat(batch);
      let offset = 0;
      while (offset < data.length) {
        const { bytesWritten } = await this.handle.write(
          data,
          offset,
          data.length - offset,
        );
        if (bytesWritten <= 0) throw new Error("Short journal write");
        offset += bytesWritten;
      }
      this.pending -= data.length;
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    do {
      this.kick();
      await this.writing;
    } while (this.queue.length);
    try {
      await this.handle?.sync();
    } catch {
      this.failed = true;
    } finally {
      try {
        await this.handle?.close();
      } catch {
        this.failed = true;
      }
    }
  }
}
/** Read committed prefix; an unterminated final record is never committed. Hash errors fail closed. */
export async function readJournal(
  path: string,
  maxBytes = 33554432,
): Promise<JournalRecord[]> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes)
    throw new Error("Unsafe journal file");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let content: string;
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.size > maxBytes)
      throw new Error("Unsafe journal file");
    content = await readFile(file, { encoding: "utf8" });
    if (Buffer.byteLength(content) > maxBytes)
      throw new Error("Journal grew beyond limit");
  } finally {
    await file.close();
  }
  const records: JournalRecord[] = [];
  let previous = "0".repeat(64);
  const lines = content.split("\n");
  lines.pop();
  for (const line of lines) {
    const r = JSON.parse(line) as JournalRecord;
    if (
      r.n !== records.length ||
      r.previous !== previous ||
      hash({ n: r.n, previous: r.previous, data: r.data }) !== r.hash
    )
      throw new Error("Corrupt journal record");
    records.push(r);
    previous = r.hash;
  }
  return records;
}
