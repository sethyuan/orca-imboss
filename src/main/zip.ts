import { inflateRawSync } from "zlib";

/**
 * Minimal, dependency-free ZIP reader.
 *
 * A skill is distributed as a `.zip`, and adding an unpack library for one
 * feature is not worth it: the archive is read through its central directory
 * (which always carries the real sizes, so entries written with a trailing
 * data descriptor — GitHub's own zipballs, for one — work fine) and entries
 * are inflated with Node's `zlib`. Only what a skill needs is supported:
 * stored and deflated entries, no encryption, no Zip64.
 *
 * Every path is validated here rather than by the caller, so an archive can
 * never escape the folder it is unpacked into.
 */

/** One regular file from the archive. Directory entries are dropped. */
export interface ZipEntry {
  /** `/`-separated path, relative to the archive root. */
  path: string;
  data: Buffer;
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** End-of-central-directory record: 22 bytes, plus a comment up to 64 KiB. */
const EOCD_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;

/** Guards so a hostile archive cannot exhaust memory while being read. */
const MAX_ENTRIES = 2000;
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

const FLAG_ENCRYPTED = 0x1;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/**
 * Read every regular file out of a ZIP archive. Throws a plain-language error
 * for anything unusable (not a zip, damaged, encrypted, Zip64, unsupported
 * compression, a path that would escape the destination, or too big).
 */
export function readZipEntries(buffer: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);

  if (
    count === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new Error("Zip64 archives are not supported.");
  }
  if (count > MAX_ENTRIES) {
    throw new Error(
      `Too many files in the archive (${count}; the limit is ${MAX_ENTRIES}).`,
    );
  }
  if (centralOffset + centralSize > buffer.length) {
    throw new Error("Damaged zip archive.");
  }

  const entries: ZipEntry[] = [];
  let total = 0;
  let offset = centralOffset;

  for (let index = 0; index < count; index += 1) {
    if (
      offset + 46 > buffer.length ||
      buffer.readUInt32LE(offset) !== CENTRAL_SIG
    ) {
      throw new Error("Damaged zip archive.");
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const rawName = buffer
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf8");
    offset += 46 + nameLength + extraLength + commentLength;

    if ((flags & FLAG_ENCRYPTED) !== 0) {
      throw new Error("Encrypted archives are not supported.");
    }
    const path = normalizeEntryPath(rawName);
    if (path === null) continue; // directory entry
    if (
      compressedSize > MAX_ENTRY_BYTES ||
      uncompressedSize > MAX_ENTRY_BYTES
    ) {
      throw new Error(
        `"${path}" is too large for a skill (the limit is ${formatBytes(MAX_ENTRY_BYTES)} per file).`,
      );
    }
    total += uncompressedSize;
    if (total > MAX_TOTAL_BYTES) {
      throw new Error(
        `The archive holds more than ${formatBytes(MAX_TOTAL_BYTES)} of files.`,
      );
    }

    if (
      localOffset + 30 > buffer.length ||
      buffer.readUInt32LE(localOffset) !== LOCAL_SIG
    ) {
      throw new Error("Damaged zip archive.");
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    if (compressed.length !== compressedSize) {
      throw new Error("Damaged zip archive.");
    }

    entries.push({ path, data: inflateEntry(path, method, compressed) });
  }

  return entries;
}

function inflateEntry(
  path: string,
  method: number,
  compressed: Buffer,
): Buffer {
  if (method === METHOD_STORE) return Buffer.from(compressed);
  if (method !== METHOD_DEFLATE) {
    throw new Error(`Unsupported compression in "${path}" (method ${method}).`);
  }
  try {
    return inflateRawSync(compressed);
  } catch {
    throw new Error(`Could not unpack "${path}".`);
  }
}

/**
 * Locate the end-of-central-directory record, scanning backwards over any
 * archive comment. Returns its offset.
 */
function findEndOfCentralDirectory(buffer: Buffer): number {
  if (buffer.length < EOCD_BYTES) throw new Error("Not a zip archive.");
  const first = Math.max(0, buffer.length - EOCD_BYTES - MAX_COMMENT_BYTES);
  for (let offset = buffer.length - EOCD_BYTES; offset >= first; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIG) return offset;
  }
  throw new Error("Not a zip archive.");
}

/**
 * Turn an entry name into a safe relative path, or `null` for a directory
 * entry. Anything absolute, drive-lettered, or containing `..` is refused
 * rather than silently skipped: an archive like that is not a skill.
 */
function normalizeEntryPath(raw: string): string | null {
  const name = raw.replace(/\\/g, "/");
  if (name.endsWith("/")) return null;
  if (name.length === 0) return null;
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    throw new Error(`Unsafe path in the archive: "${raw}".`);
  }
  const parts = name.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Unsafe path in the archive: "${raw}".`);
  }
  return parts.join("/");
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
