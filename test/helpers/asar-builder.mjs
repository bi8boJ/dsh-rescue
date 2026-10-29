import fs from 'node:fs';
import path from 'node:path';

/**
 * Build a minimal but byte-accurate Electron asar archive, matching the layout
 * the real DSH app.asar uses: 16 bytes of header, then the JSON directory tree,
 * then (4-byte aligned) payload.
 */
export function buildAsar(entries) {
  const tree = { files: {} };
  const blobs = [];
  let offset = 0;
  for (const [entryPath, content] of Object.entries(entries)) {
    const parts = String(entryPath).split('/').filter(Boolean);
    let node = tree;
    for (const part of parts.slice(0, -1)) {
      if (!node.files[part]) node.files[part] = { files: {} };
      node = node.files[part];
    }
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    node.files[parts[parts.length - 1]] = { size: data.length, offset: String(offset) };
    blobs.push(data);
    offset += data.length;
  }

  const json = Buffer.from(JSON.stringify(tree), 'utf8');
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(8 + json.length, 4);
  head.writeUInt32LE(4 + json.length, 8);
  head.writeUInt32LE(json.length, 12);

  const chunks = [head, json];
  let position = 16 + json.length;
  while (position % 4 !== 0) {
    chunks.push(Buffer.from([0]));
    position += 1;
  }
  return Buffer.concat([...chunks, ...blobs]);
}

export function writeAsar(dir, entries, name = 'app.asar') {
  const target = path.join(dir, name);
  fs.writeFileSync(target, buildAsar(entries));
  return target;
}