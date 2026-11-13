/**
 * Finding the ink an annotation baked into a picture.
 *
 * The structural promise this feature makes is "the marked copy is composed from the
 * **original** file, so annotating a picture twice never stacks marks". Nothing in the
 * records can prove that (the records are identical either way) — only the pixels can.
 * So the tests decode the delivered file and look for the mark colour: one cluster per
 * batch, at the place that batch was drawn, and never two clusters where one was
 * expected.
 *
 * Decoding happens **in the page**: the renderer already has `createImageBitmap` and a
 * canvas, and `files:readImageBytes` hands over the bytes (the same controlled channel
 * the bake uses). That keeps this helper free of a PNG decoder in Node.
 */

/** One connected blob of mark ink, in the picture's own pixels. */
export interface InkCluster {
  /** Blob bounding box. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Pixels in the blob (a badge is a few hundred at 2000px, a ring fewer). */
  pixels: number;
}

export interface InkResult {
  width: number;
  height: number;
  clusters: InkCluster[];
}

/** A page with the preload bridge (the shape this helper needs). */
interface BridgeWindow {
  imb: {
    files: {
      readImageBytes(path: string): Promise<{ mime: string; dataUrl: string }>;
    };
  };
}

/**
 * What counts as mark ink (`#c93a3a` = 201, 58, 58), stated loosely on purpose: a
 * ring's stroke is only 2–3 px wide and antialiasing leaves neighbouring shades, so a
 * generous window is the right tool. "Is there red ink where the mark should be" is
 * the question; exact values are the bake's job. The bounds are literals inside the
 * page function because that is where the pixels are read.
 */
/**
 * Decode one picture and return the connected blobs of mark ink.
 *
 * `minPixels` drops single antialiased pixels (a stray neighbour of the mark, a red
 * 1×1 dot a fixture drew); a real badge or ring is always larger.
 */
export async function inkClusters(
  window: import("@playwright/test").Page,
  path: string,
  minPixels = 40,
): Promise<InkResult> {
  return await window.evaluate(
    async (input: { path: string; minPixels: number }) => {
      const imb = (window as unknown as BridgeWindow).imb;
      const { dataUrl } = await imb.files.readImageBytes(input.path);
      const comma = dataUrl.indexOf(",");
      const binary = atob(dataUrl.slice(comma + 1));
      const bytes = new Uint8Array(binary.length);
      for (let at = 0; at < binary.length; at += 1) {
        bytes[at] = binary.charCodeAt(at);
      }
      const bitmap = await createImageBitmap(
        new Blob([bytes], { type: "image/png" }),
      );
      const width = bitmap.width;
      const height = bitmap.height;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (ctx === null) throw new Error("no 2d context");
      ctx.drawImage(bitmap, 0, 0);
      const { data } = ctx.getImageData(0, 0, width, height);
      const isInk = (at: number): boolean =>
        data[at] !== undefined &&
        (data[at] as number) >= 120 &&
        (data[at + 1] as number) <= 110 &&
        (data[at + 2] as number) <= 110;
      // 4-connected flood fill over the ink mask (widths are ≤2000, so a plain
      // stack-based fill is plenty and keeps this readable).
      const seen = new Uint8Array(width * height);
      const clusters: {
        left: number;
        top: number;
        width: number;
        height: number;
        pixels: number;
      }[] = [];
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const start = y * width + x;
          if (seen[start] !== 0) continue;
          if (!isInk(start * 4)) continue;
          let minX = x;
          let maxX = x;
          let minY = y;
          let maxY = y;
          let pixels = 0;
          const stack: number[] = [start];
          seen[start] = 1;
          while (stack.length > 0) {
            const at = stack.pop() as number;
            const px = at % width;
            const py = (at - px) / width;
            pixels += 1;
            if (px < minX) minX = px;
            if (px > maxX) maxX = px;
            if (py < minY) minY = py;
            if (py > maxY) maxY = py;
            for (const next of [at - 1, at + 1, at - width, at + width]) {
              if (next < 0 || next >= seen.length) continue;
              if (seen[next] !== 0) continue;
              const nx = next % width;
              if (Math.abs(nx - px) > 1) continue;
              if (!isInk(next * 4)) continue;
              seen[next] = 1;
              stack.push(next);
            }
          }
          if (pixels >= input.minPixels) {
            clusters.push({
              left: minX,
              top: minY,
              width: maxX - minX + 1,
              height: maxY - minY + 1,
              pixels,
            });
          }
        }
      }
      bitmap.close();
      return { width, height, clusters };
    },
    { path, minPixels },
  );
}

/**
 * Merge clusters that belong to the **same mark**.
 *
 * One mark is not one blob: a point is a thin ring plus a badge whose white outline
 * cuts the ring off, so a single annotation is two (or three) blobs a few pixels
 * apart. What the assertions care about is "how many marks", so blobs closer than
 * `gapPx` are one mark. A baked batch that stacked a second mark on top of a first
 * would land ~hundreds of pixels away, well outside any sensible gap.
 */
export function markGroups(
  clusters: readonly InkCluster[],
  gapPx: number,
): InkCluster[] {
  const groups: InkCluster[] = clusters.map((cluster) => ({ ...cluster }));
  let merged = true;
  while (merged) {
    merged = false;
    for (let a = 0; a < groups.length; a += 1) {
      for (let b = a + 1; b < groups.length; b += 1) {
        const one = groups[a] as InkCluster;
        const two = groups[b] as InkCluster;
        const apartX = Math.max(
          0,
          Math.max(one.left, two.left) -
            Math.min(one.left + one.width, two.left + two.width),
        );
        const apartY = Math.max(
          0,
          Math.max(one.top, two.top) -
            Math.min(one.top + one.height, two.top + two.height),
        );
        if (Math.max(apartX, apartY) > gapPx) continue;
        const left = Math.min(one.left, two.left);
        const top = Math.min(one.top, two.top);
        groups[a] = {
          left,
          top,
          width: Math.max(one.left + one.width, two.left + two.width) - left,
          height: Math.max(one.top + one.height, two.top + two.height) - top,
          pixels: one.pixels + two.pixels,
        };
        groups.splice(b, 1);
        merged = true;
        break;
      }
      if (merged) break;
    }
  }
  return groups;
}

/** The centre of one cluster, as a fraction of the picture (0..1). */
export function clusterCentre(
  cluster: InkCluster,
  size: { width: number; height: number },
): { x: number; y: number } {
  return {
    x: (cluster.left + cluster.width / 2) / size.width,
    y: (cluster.top + cluster.height / 2) / size.height,
  };
}
