import type { Options } from "remark-gfm";

/**
 * The one `remark-gfm` configuration used by **every** Markdown pipeline in the
 * app (the renderer in `./index.tsx` and the plain-text flattener in
 * `./plain-text.ts`), so what a card or bubble shows and what the chat-list
 * teaser shows can never disagree.
 *
 * `singleTilde: false` — GFM (and so `micromark-extension-gfm-strikethrough`,
 * whose `singleTilde` defaults to `true`) accepts a *single* `~` as a
 * strikethrough delimiter: `~abc~` becomes `<del>abc</del>`. In chat content a
 * lone `~` is far more likely to be literal text (`~5 分钟`, `~/dev/foo`,
 * `a~b~c`), so only the explicit `~~abc~~` form may strike through here.
 */
export const GFM_OPTIONS: Options = { singleTilde: false };

/**
 * Undo the `~` escaping that `remark-stringify` applies to literal tildes once
 * single-tilde strikethrough is off (`~abc~` serializes as `\~abc\~`). Only for
 * *derived* plain text — never for a message's stored `content`, which is the
 * Markdown source other surfaces (copy, search index) must see untouched.
 *
 * A source that deliberately wrote `\~` is asking for a literal `~` too, so
 * collapsing the pair to one `~` is the intended reading either way.
 */
export function unescapeTildes(value: string): string {
  return value.replace(/\\~/g, "~");
}
