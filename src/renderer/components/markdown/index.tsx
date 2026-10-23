import { t } from "@shared/l10n";
import hljs from "highlight.js/lib/common";
import "katex/dist/katex.min.css";
import {
  isValidElement,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown, {
  type Components,
  type UrlTransform,
} from "react-markdown";
import { cls } from "reactutils";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math-extended";
import type { PluggableList } from "unified";
import { copyToClipboard } from "../../clipboard";
import { IconCheck, IconCopy } from "../icons";
import { MENTION_TAG, mentionPlugin } from "./mention";
import "./index.css";

/**
 * Markdown + KaTeX renderer for chat content.
 *
 * Security posture:
 * - Raw HTML is not rendered: react-markdown has no `rehype-raw`, so `raw` hast
 *   nodes become plain text.
 * - `urlTransform` that runs after the rehype plugins restricts link/image URLs
 *   to a small protocol allowlist (see `sanitizeUrl`), so a malicious href such
 *   as `javascript:` never reaches the DOM.
 * - KaTeX keeps its default `trust: false`, so `\href`/`\html*` commands cannot
 *   inject markup.
 * - Highlighted code is produced by `highlight.js`, whose output is
 *   HTML-escaped before it is handed to `dangerouslySetInnerHTML`.
 */

/** Module-level plugin lists keep referential stability across re-renders. */
const REMARK_PLUGINS: PluggableList = [remarkGfm, remarkMath];
const REHYPE_PLUGINS: PluggableList = [[rehypeKatex, { strict: "ignore" }]];

const SAFE_HREF_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/**
 * Restrict processed URLs. react-markdown applies this to every URL attribute
 * (`href`, `src`, …); `key` tells us which one. Anything not explicitly allowed
 * is dropped to an empty string (rendered inert by the custom components).
 */
const sanitizeUrl: UrlTransform = (url, key) => {
  const value = typeof url === "string" ? url.trim() : "";
  if (value.length === 0) return "";
  // Strip control characters and whitespace that could disguise a scheme
  // (e.g. `java\tscript:`), then inspect the leading scheme.
  const normalized = value.replace(/[\u0000-\u0020\u007f]+/g, "");
  const colon = normalized.indexOf(":");
  if (colon < 1) return "";
  const scheme = `${normalized.slice(0, colon).toLowerCase()}:`;
  if (key === "src") {
    if (scheme === "https:") return value;
    // Inline images only; never `data:text/html` or similar.
    return normalized.toLowerCase().startsWith("data:image/") ? value : "";
  }
  return SAFE_HREF_SCHEMES.has(scheme) ? value : "";
};

/** Highlight one fenced code block; falls back to escaped plain text. */
function highlightCode(code: string, language: string | undefined): string {
  try {
    if (language !== undefined && hljs.getLanguage(language)) {
      return hljs.highlight(code, { language, ignoreIllegals: true }).value;
    }
    return hljs.highlightAuto(code).value;
  } catch {
    return escapeHtml(code);
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Recursively collect the text content of a rendered node tree. */
function extractText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement(node)) {
    return extractText((node.props as { children?: ReactNode }).children);
  }
  return "";
}

/**
 * Fenced code block wrapper: the raw source is the `<code>` child's text, and
 * the copy button lives outside the horizontally scrollable `<pre>` so it
 * stays pinned to the top-right corner.
 */
function CodeBlock({ children }: { children?: ReactNode }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current);
    },
    [],
  );

  const copy = useCallback((): void => {
    const text = extractText(children).replace(/\n$/, "");
    void copyToClipboard(text)
      .then(() => {
        setCopied(true);
        if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current);
        resetTimerRef.current = setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        // Clipboard failures are non-fatal; the text stays selectable.
      });
  }, [children]);

  return (
    <div className="imb-code-block">
      <pre>{children}</pre>
      <button
        type="button"
        className="imb-code-copy"
        onClick={copy}
        aria-label={t("Copy")}
        title={copied ? t("Copied") : t("Copy")}
      >
        {copied ? (
          <IconCheck className="imb-icon imb-xs" />
        ) : (
          <IconCopy className="imb-icon imb-xs" />
        )}
      </button>
    </div>
  );
}

/**
 * Build the element overrides. `inline` adds a paragraph unwrapper so the
 * output stays phrasing content and can be embedded in labels/table cells.
 */
function createComponents(
  inline: boolean,
  onMentionClick?: (id: number) => void,
): Components {
  const components: Components = {
    a({ href, title, children }) {
      if (typeof href !== "string" || href.length === 0) {
        return <span className="imb-md-link-inert">{children}</span>;
      }
      return (
        <a href={href} title={title} target="_blank" rel="noreferrer noopener">
          {children}
        </a>
      );
    },
    img({ src, alt, title }) {
      if (typeof src !== "string" || src.length === 0) return null;
      return (
        <img
          src={src}
          alt={alt ?? ""}
          title={title}
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      );
    },
    code({ className, children }) {
      const language = /language-([\w-]+)/.exec(className ?? "")?.[1];
      if (language === undefined) {
        // Inline code, or a fenced block without an info string; the `pre`
        // wrapper (when present) is styled by CSS.
        return <code className={className}>{children}</code>;
      }
      const source = String(children).replace(/\n$/, "");
      return (
        <code
          className={cls(className, "hljs")}
          dangerouslySetInnerHTML={{ __html: highlightCode(source, language) }}
        />
      );
    },
  };

  // Custom element emitted by the mention rehype plugin. The display name is
  // already in `children`; `node` carries the employee id used as a click
  // target. The tag is not a known intrinsic element, so it is added through a
  // cast.
  const Mention = (props: {
    node?: { properties?: Record<string, unknown> };
    children?: ReactNode;
  }): React.JSX.Element => {
    const raw = props.node?.properties?.employeeId;
    const id = typeof raw === "number" ? raw : Number(raw);
    if (onMentionClick !== undefined && Number.isSafeInteger(id)) {
      return (
        <button
          type="button"
          className="imb-mention"
          onClick={() => onMentionClick(id)}
        >
          {props.children}
        </button>
      );
    }
    return <span className="imb-mention">{props.children}</span>;
  };
  (components as Record<string, unknown>)[MENTION_TAG] = Mention;

  if (inline) {
    components.p = ({ children }) => <>{children}</>;
  } else {
    components.pre = CodeBlock;
  }
  return components;
}

export interface MarkdownProps {
  content: string;
  /** Render as phrasing content (no block wrapper); for labels and table cells. */
  inline?: boolean;
  className?: string;
  /** Resolve `@<id>` mentions to display names; omit to leave them as raw text. */
  resolveMention?: (id: number) => string | null;
  /** When set, a resolved mention becomes a button that calls this with the id. */
  onMentionClick?: (id: number) => void;
}

/**
 * Memoized so a thread re-render (e.g. a new message) does not re-parse every
 * already-rendered message.
 */
export const Markdown = memo(function Markdown({
  content,
  inline = false,
  className,
  resolveMention,
  onMentionClick,
}: MarkdownProps): React.JSX.Element {
  const components = useMemo(
    () => createComponents(inline, onMentionClick),
    [inline, onMentionClick],
  );
  // Run the mention plugin before `rehype-katex`: math is still a `code` /
  // `math`-classed subtree the plugin skips, so a mention inside math is never
  // rewritten either way.
  const rehypePlugins = useMemo<PluggableList>(() => {
    if (resolveMention === undefined) return REHYPE_PLUGINS;
    return [
      [mentionPlugin, { resolve: resolveMention }],
      ...REHYPE_PLUGINS,
    ] as PluggableList;
  }, [resolveMention]);
  const Wrapper = inline ? "span" : "div";
  return (
    <Wrapper
      className={cls(
        "imb-markdown",
        inline && "imb-markdown-inline",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={rehypePlugins}
        urlTransform={sanitizeUrl}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </Wrapper>
  );
});
