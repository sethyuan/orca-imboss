import type { CommentAnchor } from "@shared/types";

/**
 * Rendered-text index of one message body: the *rendered* text plus a map back
 * to the text nodes it came from.
 *
 * Comments anchor on rendered text (not on the stored Markdown) because that is
 * what the boss selects and what the inline highlight must address. Both ends —
 * capturing a selection and resolving a stored anchor — build the index with
 * this module, which is what makes their offsets agree.
 *
 * Conventions (they only have to be *consistent*, and they are):
 * - one `\n` is synthesized before a new block-level element, so a quote spanning
 *   two paragraphs stays readable in the prompt and in the comment card;
 * - text inside `aria-hidden="true"` subtrees (notably KaTeX's duplicated
 *   `.katex-mathml` MathML) is skipped, so math never doubles the offsets;
 * - whitespace inside a text node is kept verbatim.
 */

/** One run of rendered text and where it lives in the DOM. */
interface TextSegment {
  node: Text;
  /** Start offset in {@link TextIndex.text}. */
  start: number;
  /** End offset in {@link TextIndex.text} (exclusive). */
  end: number;
}

/** The rendered text of one element, with its source segments. */
export interface TextIndex {
  text: string;
  segments: TextSegment[];
}

/** Tags that start a new visual block (a `\n` goes in front of the first text). */
const BLOCK_TAGS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DD",
  "DIV",
  "DL",
  "DT",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "TBODY",
  "TD",
  "TFOOT",
  "TH",
  "THEAD",
  "TR",
  "UL",
]);

/** Skipped subtrees: KaTeX's accessible-math duplicate, and any hidden subtree. */
function isSkipped(element: Element): boolean {
  return (
    element.getAttribute("aria-hidden") === "true" ||
    element.classList.contains("katex-mathml")
  );
}

/** Nearest block-level ancestor of `node` inside `root` (`root` itself at worst). */
function blockOf(node: Node, root: HTMLElement): Element | null {
  let current = node.parentElement;
  while (current !== null) {
    if (BLOCK_TAGS.has(current.tagName)) return current;
    if (current === root) return null;
    current = current.parentElement;
  }
  return null;
}

/**
 * Build the rendered-text index of `root`.
 *
 * Cost is proportional to the text in the row, which is why callers build it per
 * annotated row rather than for the whole thread.
 */
export function buildTextIndex(root: HTMLElement): TextIndex {
  const segments: TextSegment[] = [];
  let text = "";
  let lastBlock: Element | null = null;
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(node): number {
        if (node.nodeType === Node.ELEMENT_NODE) {
          return isSkipped(node as Element)
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    },
  );
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const value = node.nodeValue ?? "";
    if (value.length === 0) continue;
    const block = blockOf(node, root);
    if (block !== lastBlock) {
      if (text.length > 0) text += "\n";
      lastBlock = block;
    }
    segments.push({
      node: node as Text,
      start: text.length,
      end: text.length + value.length,
    });
    text += value;
  }
  return { text, segments };
}

/** The first index segment inside `element` (in document order). */
function firstSegmentOf(index: TextIndex, element: Node): TextSegment | null {
  for (const segment of index.segments) {
    if (element.contains(segment.node)) return segment;
  }
  return null;
}

/** The last index segment inside `element` (in document order). */
function lastSegmentOf(index: TextIndex, element: Node): TextSegment | null {
  for (let i = index.segments.length - 1; i >= 0; i -= 1) {
    if (element.contains(index.segments[i].node)) return index.segments[i];
  }
  return null;
}

/**
 * Convert one DOM point (an end of a `Range`) to an offset in `index.text`.
 *
 * Text-node containers are the normal case. An **element** container happens for
 * a selection that covers whole blocks (a triple-click, a select-all inside the
 * row); it is resolved to the boundary of the neighbouring segment, which is what
 * a reader expects — the paragraph's text, without its chrome.
 *
 * The direction matters: a boundary *before* a child must land on the previous
 * child's text for an end point (the selection stops there) and on the next
 * child's text for a start point (the selection begins there). Getting it
 * backwards would make an end point overshoot into the following paragraph.
 */
function offsetOfPoint(
  index: TextIndex,
  container: Node,
  offset: number,
  side: "start" | "end",
): number | null {
  if (container.nodeType === Node.TEXT_NODE) {
    const segment = index.segments.find((item) => item.node === container);
    if (segment === undefined) return null;
    const length = container.nodeValue?.length ?? 0;
    return segment.start + Math.min(Math.max(offset, 0), length);
  }
  if (container.nodeType !== Node.ELEMENT_NODE) return null;
  const children = container.childNodes;
  const next = children[offset] ?? null;
  const previous = offset > 0 ? children[offset - 1] : null;
  const fromNext = next === null ? null : firstSegmentOf(index, next);
  const fromPrevious =
    previous === null ? null : lastSegmentOf(index, previous);
  if (side === "start") {
    if (fromNext !== null) return fromNext.start;
    if (fromPrevious !== null) return fromPrevious.end;
    const any = firstSegmentOf(index, container);
    return any === null ? null : any.start;
  }
  if (fromPrevious !== null) return fromPrevious.end;
  if (fromNext !== null) return fromNext.start;
  const any = lastSegmentOf(index, container);
  return any === null ? null : any.end;
}

/** A DOM point: text node (or element) plus offset. */
interface Point {
  node: Text;
  offset: number;
}

/**
 * Offset in `index.text` → DOM point, snapping **outward** over synthesized
 * block separators (which live in the text but in no text node).
 */
function pointOfOffset(
  index: TextIndex,
  offset: number,
  side: "start" | "end",
): Point | null {
  if (index.segments.length === 0) return null;
  if (side === "start") {
    for (const segment of index.segments) {
      if (offset < segment.end) {
        return {
          node: segment.node,
          offset: Math.min(
            Math.max(offset - segment.start, 0),
            segment.end - segment.start,
          ),
        };
      }
    }
    return null;
  }
  for (let i = index.segments.length - 1; i >= 0; i -= 1) {
    const segment = index.segments[i];
    if (offset > segment.start) {
      return {
        node: segment.node,
        offset: Math.min(
          Math.max(offset - segment.start, 0),
          segment.end - segment.start,
        ),
      };
    }
  }
  return { node: index.segments[0].node, offset: 0 };
}

/** A resolved span: what the highlight draws. */
export interface ResolvedSpan {
  start: number;
  end: number;
}

/** Outcome of resolving one anchor against one row's rendered text. */
export type AnchorResolution =
  | { kind: "exact"; span: ResolvedSpan }
  | { kind: "relocated"; span: ResolvedSpan }
  | { kind: "unresolved" };

/** Drop every whitespace character (comparison of selection text vs stored text). */
function stripWhitespace(value: string): string {
  return value.replace(/\s+/g, "");
}

/** Whitespace-normalize a string, keeping a map back to the raw offsets. */
function normalizeWithMap(text: string): { text: string; map: number[] } {
  let normalized = "";
  const map: number[] = [];
  let insideSpace = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (insideSpace) continue;
      insideSpace = true;
      normalized += " ";
      map.push(i);
      continue;
    }
    insideSpace = false;
    normalized += ch;
    map.push(i);
  }
  return { text: normalized, map };
}

/** Index of the `occurrence`-th (0-based) exact occurrence of `quote`, or -1. */
function findOccurrence(
  text: string,
  quote: string,
  occurrence: number,
): number {
  let from = 0;
  for (let seen = 0; seen <= occurrence; seen += 1) {
    const at = text.indexOf(quote, from);
    if (at < 0) return -1;
    if (seen === occurrence) return at;
    from = at + 1;
  }
  return -1;
}

/**
 * Resolve one stored anchor against the rendered text of its row.
 *
 * Three steps, each validated before it is used — a comment must never be
 * highlighted in the wrong place:
 *
 * 1. the stored offsets, when the slice still equals the quote (and, ideally, the
 *    row's text length is unchanged: the drift detector);
 * 2. the quote's stored occurrence, searched in the current text;
 * 3. a whitespace-insensitive search, for the case where re-rendering changed
 *    only the spacing.
 *
 * Otherwise `unresolved`: the comment stays in the list, it just gets no inline
 * tint.
 */
export function resolveAnchor(
  index: TextIndex,
  anchor: CommentAnchor,
): AnchorResolution {
  const { quote } = anchor;
  const hasOffsets =
    anchor.start >= 0 &&
    anchor.end > anchor.start &&
    anchor.end <= index.text.length;
  if (hasOffsets && index.text.slice(anchor.start, anchor.end) === quote) {
    return {
      kind: anchor.textLength === index.text.length ? "exact" : "relocated",
      span: { start: anchor.start, end: anchor.end },
    };
  }
  const exact = findOccurrence(index.text, quote, anchor.occurrence);
  if (exact >= 0) {
    return {
      kind: "relocated",
      span: { start: exact, end: exact + quote.length },
    };
  }
  const haystack = normalizeWithMap(index.text);
  const needle = normalizeWithMap(quote).text;
  if (needle.length === 0) return { kind: "unresolved" };
  const at = haystack.text.indexOf(needle);
  if (at < 0) return { kind: "unresolved" };
  const start = haystack.map[at] ?? 0;
  const last = haystack.map[at + needle.length - 1];
  if (last === undefined) return { kind: "unresolved" };
  return { kind: "relocated", span: { start, end: last + 1 } };
}

/** Build a live `Range` for one resolved span, or `null` when it cannot exist. */
export function rangeForSpan(
  index: TextIndex,
  span: ResolvedSpan,
): Range | null {
  const start = pointOfOffset(index, span.start, "start");
  const end = pointOfOffset(index, span.end, "end");
  if (start === null || end === null) return null;
  const range = document.createRange();
  try {
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
  } catch {
    // A detached/moved node between the two calls: no highlight rather than a
    // wrong one.
    return null;
  }
  return range;
}

/**
 * Build the anchor for the current selection, or `null` when the selection is
 * not one a comment may point at.
 *
 * A selection qualifies when both ends are inside `root` (the row's commentable
 * content) and it is not collapsed. Element containers are supported through
 * `offsetOfPoint` (a triple-click selecting a whole paragraph is a normal way to
 * write a comment).
 */
export function anchorFromSelection(
  root: HTMLElement,
  range: Range,
  targetKind: "chat" | "session",
  targetId: number | string,
  maxQuoteLength: number,
): CommentAnchor | null {
  if (range.collapsed) return null;
  // The selection must *begin* inside the content root: a drag that starts in the
  // row's chrome (an avatar, a chip) is not an annotation of its prose.
  if (!root.contains(range.startContainer)) return null;
  const index = buildTextIndex(root);
  const rawStart = offsetOfPoint(
    index,
    range.startContainer,
    range.startOffset,
    "start",
  );
  // The **end** boundary may legitimately fall outside the content root: a
  // triple-click (and several other Chromium block selections) ends at the start
  // of the *next* block, not at the end of the text it visibly selected. That
  // boundary is clamped to the root, and the selection's own text then decides
  // whether the whole selection really is this row's text (see below) — a
  // selection that genuinely reaches into another row is rejected there, which is
  // why clamping cannot widen what may be annotated.
  const endInsideRoot = root.contains(range.endContainer);
  const rawEnd = endInsideRoot
    ? offsetOfPoint(index, range.endContainer, range.endOffset, "end")
    : index.text.length;
  if (rawStart === null || rawEnd === null || rawEnd <= rawStart) return null;
  // Guard against "the selection actually covers other rows": the text the
  // browser reports must be the text we are about to store. Whitespace is ignored
  // because the index synthesizes block separators the DOM does not have.
  if (
    stripWhitespace(range.toString()) !==
    stripWhitespace(index.text.slice(rawStart, rawEnd))
  ) {
    return null;
  }
  // Trim the selection (a drag usually catches surrounding whitespace) and clamp
  // it to what a stored quote may carry; both adjustments move the offsets, never
  // the text they point at.
  let start = rawStart;
  let end = rawEnd;
  while (start < end && /\s/.test(index.text[start])) start += 1;
  while (end > start && /\s/.test(index.text[end - 1])) end -= 1;
  if (end - start > maxQuoteLength) end = start + maxQuoteLength;
  const quote = index.text.slice(start, end);
  if (quote.trim().length === 0) return null;
  const occurrence = index.text.slice(0, start).split(quote).length - 1;
  return {
    target:
      targetKind === "chat"
        ? { kind: "message", messageId: Number(targetId) }
        : { kind: "entry", entryId: String(targetId) },
    quote,
    start,
    end,
    occurrence,
    textLength: index.text.length,
  };
}
