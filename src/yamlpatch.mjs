/**
 * Line-level editing of `cordis.patch.yml`.
 *
 * We never parse-and-re-dump: the patch layer can hold comments, `!!js`
 * expressions, anchors and a specific key order, and any YAML round-trip
 * would silently rewrite it. Disabling an entry is an append of the two
 * lines DSH documents as the minimal form (`- id: <id>` + `disabled: true`),
 * which the host merges by id.
 */

// Entry rows are root-level list items. `- id: <model>` nested inside a
// `config:` block is a model id, not an entry id, and must not be counted.
const ID_RE = /^-\s+id:\s*(['"]?)([^'"\s#]+)\1/;
const TOP_ITEM_RE = /^-\s+/;
const DISABLED_RE = /^\s+disabled:\s*(.*?)\s*$/;
const COMMENT_OR_EMPTY_RE = /^\s*$|^\s*#/;

export function analyzePatch(text) {
  const source = text === undefined || text === null ? '' : String(text);
  const lines = source.split(/\r?\n/);
  const ids = [];
  const idLines = [];
  lines.forEach((line, index) => {
    const match = ID_RE.exec(line);
    if (match) {
      ids.push(match[2]);
      idLines.push(index);
    }
  });
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  const contentLines = lines.filter((line) => !COMMENT_OR_EMPTY_RE.test(line));
  const blank = source.trim() === '';
  return {
    blank,
    commentsOnly: !blank && contentLines.length === 0,
    entryCount: lines.filter((line) => TOP_ITEM_RE.test(line)).length,
    ids,
    idLines,
    duplicates: [...new Set(duplicates)],
    hasCrlf: source.includes('\r\n'),
    hasTabIndent: lines.some((line) => /^\t/.test(line)),
    layerDisabled: isLayerDisabled(source),
    bytes: Buffer.byteLength(source, 'utf8'),
  };
}

export function isLayerDisabled(text) {
  const source = text === undefined || text === null ? '' : String(text);
  const stripped = source
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
    .replace(/\s+/g, '');
  return stripped === '[]';
}

export function isEntryDisabled(text, id) {
  const source = String(text ?? '');
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = ID_RE.exec(lines[index]);
    if (!match || match[2] !== id) continue;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (TOP_ITEM_RE.test(lines[cursor])) break;
      const disabled = DISABLED_RE.exec(lines[cursor]);
      if (disabled) return disabled[1] === 'true';
    }
    return false;
  }
  return false;
}

export function formatDisableBlock(id, newline = '\n') {
  return [`- id: ${id}`, '  disabled: true'].join(newline);
}

/**
 * Append a disable row. Never rewrites existing lines, so everything the user
 * wrote (including comments and `!!js` expressions) survives byte for byte.
 *
 * @returns {{text: string, changed: boolean, reason?: 'already-disabled'|'entry-exists'}}
 */
export function appendDisable(text, id) {
  if (typeof id !== 'string' || id.trim() === '') throw new Error('appendDisable: id is required');
  const cleanId = id.trim();
  const source = text === undefined || text === null ? '' : String(text);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const info = analyzePatch(source);

  if (info.ids.includes(cleanId)) {
    return {
      text: source,
      changed: false,
      reason: isEntryDisabled(source, cleanId) ? 'already-disabled' : 'entry-exists',
    };
  }

  const block = formatDisableBlock(cleanId, newline);

  if (info.layerDisabled) {
    // `[]` is a flow sequence; a block sequence cannot follow it, so drop the
    // flow marker (keeping any comments) and append the row.
    const kept = source
      .split(/\r?\n/)
      .filter((line) => !/^\s*\[\]\s*(#.*)?$/.test(line))
      .join(newline);
    const base = kept === '' ? '' : kept.endsWith(newline) ? kept : `${kept}${newline}`;
    return { text: `${base}${block}${newline}`, changed: true };
  }

  if (source === '') return { text: `${block}${newline}`, changed: true };

  let base = source.endsWith(newline) ? source : `${source}${newline}`;
  const normalized = base.replace(/\r/g, '');
  if (!normalized.endsWith('\n\n')) base += newline;
  return { text: `${base}${block}${newline}`, changed: true };
}

/** Append a free-form comment block (used as a breadcrumb by safe-mode). */
export function appendComment(text, comment) {
  const source = text === undefined || text === null ? '' : String(text);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = String(comment)
    .split(/\r?\n/)
    .map((line) => `# ${line}`)
    .join(newline);
  if (source === '') return `${lines}${newline}`;
  const base = source.endsWith(newline) ? source : `${source}${newline}`;
  return `${base}${lines}${newline}`;
}