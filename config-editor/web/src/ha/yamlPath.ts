/**
 * Line based YAML context finder. Completion happens while the document is
 * usually *invalid* (half typed keys), so a real parser can't be relied upon;
 * this walks indentation instead.
 */

export const ITEM = Symbol('item');
export type PathPart = string | typeof ITEM;

export interface LineInfo {
  indent: number; // leading whitespace
  dashCol: number | null; // column of the first "- " marker
  keyCol: number; // column where the key (or scalar) starts after dashes
  key: string | null;
  rest: string; // text after "key:" (comment stripped) or the scalar for item lines
  blank: boolean;
}

const KEY_RE = /^("[^"]*"|'[^']*'|[^\s:#'"[\]{},&*!|>%@`-][^:#]*?|-[^\s:#][^:#]*?)\s*:(?:\s+|$)(.*)$/;

export function parseLine(text: string): LineInfo {
  const m = /^(\s*)((?:-(?:\s+|$))*)(.*)$/.exec(text)!;
  const indent = m[1].length;
  const dashes = m[2];
  const body = m[3];
  const keyCol = indent + dashes.length;
  const blank = body.trim() === '' && dashes === '' || body.trimStart().startsWith('#');
  const km = KEY_RE.exec(body);
  let key: string | null = null;
  let rest = body;
  if (km) {
    key = km[1].replace(/^["']|["']$/g, '');
    rest = km[2];
  }
  rest = rest.replace(/\s+#.*$/, '').trim();
  return { indent, dashCol: dashes ? indent : null, keyCol, key, rest, blank };
}

export interface PathResult {
  /** Path of the mapping (or sequence item) that contains the cursor line. */
  path: PathPart[];
  /** For each entry in path, the line index it was found on. */
  lines: number[];
}

/** True when the text after a key means "children follow on the next lines". */
const opensBlock = (info: LineInfo) => info.key !== null && (info.rest === '' || /^[&!]\S*$/.test(info.rest));

/**
 * Path to the mapping that holds the line at `lineIdx`. When that line starts a
 * list item the path ends with ITEM (the item itself is the mapping).
 */
export function pathFor(lines: string[], lineIdx: number): PathResult {
  const cur = parseLine(lines[lineIdx] ?? '');
  const path: PathPart[] = [];
  const at: number[] = [];
  let seq = cur.dashCol !== null; // true: `col` is a sequence's dash column; false: a mapping's key column
  let col = seq ? cur.dashCol! : cur.keyCol;
  if (seq) {
    path.push(ITEM);
    at.push(lineIdx);
  }

  const push = (part: PathPart, i: number) => {
    path.unshift(part);
    at.unshift(i);
  };
  const enterOwner = (info: LineInfo, i: number) => {
    push(info.key!, i);
    seq = false;
    col = info.keyCol;
    if (info.dashCol !== null) {
      push(ITEM, i);
      seq = true;
      col = info.dashCol;
    }
  };

  for (let i = lineIdx - 1; i >= 0; i--) {
    const info = parseLine(lines[i]);
    if (info.blank) continue;
    if (seq) {
      if (info.dashCol === col || info.keyCol > col) continue; // sibling items / their content
      if (opensBlock(info)) enterOwner(info, i);
    } else if (info.keyCol > col) {
      continue;
    } else if (info.keyCol === col) {
      if (info.dashCol !== null) {
        // head line of the item mapping we are inside
        push(ITEM, i);
        seq = true;
        col = info.dashCol;
      }
    } else if (opensBlock(info)) {
      enterOwner(info, i);
    }
  }
  return { path, lines: at };
}

/** Every line of the mapping that contains `lineIdx`, as parsed info (the line itself included). */
function mappingLines(lines: string[], lineIdx: number): { info: LineInfo; idx: number }[] {
  const base = parseLine(lines[lineIdx] ?? '');
  const col = base.keyCol;
  const out = [{ info: base, idx: lineIdx }];
  for (let i = lineIdx - 1; i >= 0; i--) {
    const info = parseLine(lines[i]);
    if (info.blank) continue;
    if (info.keyCol < col) break;
    out.push({ info, idx: i });
    if (info.dashCol !== null && info.keyCol === col) break; // head of this item
  }
  for (let i = lineIdx + 1; i < lines.length; i++) {
    const info = parseLine(lines[i]);
    if (info.blank) continue;
    if (info.keyCol < col || (info.dashCol !== null && info.keyCol === col)) break;
    out.push({ info, idx: i });
  }
  return out.filter(({ info }) => info.keyCol === col);
}

/** Scalar `key: value` pairs of the mapping that contains the key on `lineIdx`. */
export function siblingScalars(lines: string[], lineIdx: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { info } of mappingLines(lines, lineIdx)) {
    if (info.key && info.rest && !/^[|>]/.test(info.rest)) out[info.key] = info.rest.replace(/^["']|["']$/g, '');
  }
  return out;
}

/** Keys already present in the mapping that contains `lineIdx` (excluding the line itself). */
export function siblingKeys(lines: string[], lineIdx: number): Set<string> {
  return new Set(
    mappingLines(lines, lineIdx)
      .filter(({ idx, info }) => idx !== lineIdx && info.key)
      .map(({ info }) => info.key!),
  );
}
