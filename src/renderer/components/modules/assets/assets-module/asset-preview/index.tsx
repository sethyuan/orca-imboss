import { t } from "@shared/l10n";
import type { AssetDetail, AssetRef } from "@shared/types";
import { useEffect, useState } from "react";
import { Markdown } from "../../../../markdown";
import { extensionOf, refOf } from "../helpers";
import "./index.css";

const TEXT_EXTENSIONS = new Set([
  "txt",
  "log",
  "json",
  "xml",
  "yaml",
  "yml",
  "csv",
  "tsv",
  "html",
  "htm",
  "tex",
]);

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);

function isPdf(asset: AssetDetail): boolean {
  return asset.type === "application/pdf" || extensionOf(asset.name) === "pdf";
}

function isMarkdown(asset: AssetDetail): boolean {
  return MARKDOWN_EXTENSIONS.has(extensionOf(asset.name));
}

function isText(asset: AssetDetail): boolean {
  return (
    asset.type.startsWith("text/") ||
    MARKDOWN_EXTENSIONS.has(extensionOf(asset.name)) ||
    TEXT_EXTENSIONS.has(extensionOf(asset.name))
  );
}

/** Muted "cannot render here" block. */
function Unavailable(): React.JSX.Element {
  return (
    <div className="imb-asset-preview-empty">{t("Preview unavailable")}</div>
  );
}

/**
 * Category-driven preview. Object URLs are created from bytes fetched over IPC
 * and always revoked on cleanup; every async fetch is guarded by a cancelled
 * flag so a stale response can never paint over a newer selection.
 */
export function AssetPreview({
  asset,
}: {
  asset: AssetDetail;
}): React.JSX.Element {
  const ref: AssetRef = refOf(asset);
  const messageId = ref.messageId;
  const index = ref.index;
  const [url, setUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);

  const missing = asset.missing || asset.path === null;
  const category = asset.category;
  const pdf = category === "document" && isPdf(asset);
  const textLike = category === "document" && !pdf && isText(asset);
  const needsBytes =
    !missing && (category === "image" || category === "media" || pdf);

  useEffect(() => {
    setUrl(null);
    if (!needsBytes) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const bytes = await imb.assets.fileBytes({ messageId, index });
        if (cancelled || bytes === null) return;
        const type =
          category === "image"
            ? asset.type || "image/*"
            : category === "media"
              ? asset.type || "application/octet-stream"
              : "application/pdf";
        // Copy into an ArrayBuffer-backed view so the bytes satisfy `BlobPart`
        // (the IPC `Uint8Array` is typed `ArrayBufferLike`-backed).
        objectUrl = URL.createObjectURL(
          new Blob([new Uint8Array(bytes)], { type }),
        );
        setUrl(objectUrl);
      } catch {
        // A failed read falls back to the unavailable block (url stays null).
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
    // `asset` fields that affect the fetch are captured by the primitive deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageId, index, needsBytes, category, asset.type]);

  useEffect(() => {
    setText(null);
    if (!textLike || missing) return;
    let cancelled = false;
    void (async () => {
      try {
        const content = await imb.assets.textPreview({ messageId, index });
        if (!cancelled) setText(content);
      } catch {
        if (!cancelled) setText(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [messageId, index, textLike, missing]);

  if (missing) return <Unavailable />;

  if (category === "image") {
    return url === null ? (
      <Unavailable />
    ) : (
      <div className="imb-asset-preview-image-wrap">
        <img className="imb-asset-preview-image" src={url} alt={asset.name} />
      </div>
    );
  }

  if (category === "media") {
    if (url === null) return <Unavailable />;
    const isAudio = asset.type.startsWith("audio/");
    return (
      <div className="imb-asset-preview-media">
        {isAudio ? (
          <audio className="imb-asset-preview-audio" controls src={url} />
        ) : (
          <video className="imb-asset-preview-video" controls src={url} />
        )}
      </div>
    );
  }

  if (pdf) {
    return url === null ? (
      <Unavailable />
    ) : (
      <iframe
        className="imb-asset-preview-frame"
        src={url}
        title={asset.name}
      />
    );
  }

  if (textLike) {
    if (text === null) return <Unavailable />;
    return isMarkdown(asset) ? (
      <div className="imb-asset-preview-markdown">
        <Markdown content={text} />
      </div>
    ) : (
      <pre className="imb-asset-preview-text">{text}</pre>
    );
  }

  return <Unavailable />;
}
