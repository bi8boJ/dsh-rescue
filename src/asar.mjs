import fs from 'node:fs';

/**
 * Read one file out of an Electron asar archive without unpacking it.
 *
 * Layout (verified against a real DSH 0.2.1-rc.3 app.asar):
 *   0  u32  4
 *   4  u32  header size
 *   8  u32  json length + 4
 *   12 u32  json length
 *   16 ...  the JSON directory tree
 *   then the payload, aligned to 4 bytes.
 *
 * Only the field at offset 12 is relied on; the others are informational.
 */
export function readAsarEntry(asarPath, entryPath) {
  let fd;
  try {
    fd = fs.openSync(asarPath, 'r');
    const head = Buffer.alloc(16);
    if (fs.readSync(fd, head, 0, 16, 0) < 16) return null;
    const jsonLength = head.readUInt32LE(12);
    if (!Number.isFinite(jsonLength) || jsonLength <= 0 || jsonLength > 64 * 1024 * 1024) return null;

    const jsonBuffer = Buffer.alloc(jsonLength);
    if (readFully(fd, jsonBuffer, 16) < jsonLength) return null;
    const tree = JSON.parse(jsonBuffer.toString('utf8'));

    let base = 16 + jsonLength;
    while (base % 4 !== 0) base += 1;

    let node = tree;
    for (const part of String(entryPath).split('/').filter(Boolean)) {
      node = node && node.files ? node.files[part] : undefined;
      if (!node) return null;
    }
    if (node.files || node.offset === undefined || node.size === undefined) return null;

    const size = Number(node.size);
    if (!Number.isFinite(size) || size < 0 || size > 16 * 1024 * 1024) return null;
    const out = Buffer.alloc(size);
    if (readFully(fd, out, base + Number(node.offset)) < size) return null;
    return out;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function readFully(fd, buffer, position) {
  let read = 0;
  while (read < buffer.length) {
    const chunk = fs.readSync(fd, buffer, read, buffer.length - read, position + read);
    if (chunk <= 0) break;
    read += chunk;
  }
  return read;
}

/** Read a JSON entry from an asar, or `null` when it is missing/unparsable. */
export function readAsarJson(asarPath, entryPath) {
  const buffer = readAsarEntry(asarPath, entryPath);
  if (!buffer) return null;
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
}