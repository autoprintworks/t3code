#!/usr/bin/env node

/**
 * Regenerates this fork's app icons so it is distinguishable from an official
 * T3 Code install in the taskbar and in Alt-Tab (#59).
 *
 * Upstream's black plate is tinted to the fork's orange and given a round "AP"
 * corner badge. Every size the packagers need is derived here from the 1024px
 * upstream masters, so nothing is hand-edited per size.
 *
 *   node scripts/generate-fork-icons.ts
 *
 * `generate-fork-icons.test.ts` re-runs the generator and compares it against
 * the committed bytes, so the assets cannot drift away from this file.
 *
 * Outputs (all committed):
 *   assets/fork/fork-universal-1024.png   Linux and Windows master
 *   assets/fork/fork-macos-1024.png       macOS master, keeping upstream's grid padding
 *   assets/fork/fork-windows.ico          16, 24, 32, 48, 64, 128, 256
 *   assets/fork/fork-web-*                favicons and the apple touch icon
 */

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Command } from "effect/unstable/cli";
import { PNG } from "pngjs";

import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

/** Fork plate colour. Upstream's black maps to this; upstream's white stays white. */
const PLATE_TINT = { r: 0xc2, g: 0x41, b: 0x0c } as const;
const BADGE_RING = { r: 0xff, g: 0xff, b: 0xff } as const;
const BADGE_FILL = { r: 0x0b, g: 0x12, b: 0x20 } as const;

/** Badge geometry, as fractions of the master's width. */
const BADGE_CENTRE = 0.715;
const BADGE_RING_RADIUS = 0.2;
const BADGE_FILL_RADIUS = 0.174;
const GLYPH_HEIGHT = 0.118;
const GLYPH_WIDTH = 0.079;
const GLYPH_GAP = 0.024;
const GLYPH_STROKE = 0.025;

/** Glyph proportions, as fractions of the glyph box rather than of the master. */
const A_CROSSBAR_ABOVE_BASE = 0.34;
const A_COUNTER_APEX_DROP = 1.7;
const A_COUNTER_SIDE_INSET = 1.2;
const P_BOWL_HEIGHT = 0.62;

/** Samples per output pixel edge when rasterising the badge. */
const BADGE_SUPERSAMPLE = 3;

/** Sizes the hosted web build asks for: two favicons and the apple touch icon. */
const WEB_ICON_SIZES = [16, 32, 180] as const;

interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** The box a glyph is drawn into, in master pixels, with its stroke weight. */
interface GlyphBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly stroke: number;
}

/** An upward triangle, in master pixels. */
interface Triangle {
  readonly apexX: number;
  readonly apexY: number;
  readonly baseLeftX: number;
  readonly baseRightX: number;
  readonly baseY: number;
}

const inEllipse = (x: number, y: number, cx: number, cy: number, rx: number, ry: number) =>
  rx > 0 && ry > 0 && ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;

const inTriangle = (x: number, y: number, triangle: Triangle) => {
  if (y < triangle.apexY || y > triangle.baseY) return false;
  const t = (y - triangle.apexY) / (triangle.baseY - triangle.apexY);
  return (
    x >= triangle.apexX + (triangle.baseLeftX - triangle.apexX) * t &&
    x <= triangle.apexX + (triangle.baseRightX - triangle.apexX) * t
  );
};

/** Upper-case "A", drawn as a triangular outline with a crossbar. */
const inGlyphA = (x: number, y: number, box: GlyphBox) => {
  const apexX = box.x + box.width / 2;
  const baseY = box.y + box.height;
  if (
    !inTriangle(x, y, {
      apexX,
      apexY: box.y,
      baseLeftX: box.x,
      baseRightX: box.x + box.width,
      baseY,
    })
  ) {
    return false;
  }

  const crossbarCentre = baseY - box.height * A_CROSSBAR_ABOVE_BASE;
  if (Math.abs(y - crossbarCentre) <= box.stroke / 2) return true;

  return !inTriangle(x, y, {
    apexX,
    apexY: box.y + box.stroke * A_COUNTER_APEX_DROP,
    baseLeftX: box.x + box.stroke * A_COUNTER_SIDE_INSET,
    baseRightX: box.x + box.width - box.stroke * A_COUNTER_SIDE_INSET,
    baseY,
  });
};

/** Upper-case "P", drawn as a stem plus a half-elliptical bowl. */
const inGlyphP = (x: number, y: number, box: GlyphBox) => {
  if (x >= box.x && x <= box.x + box.stroke && y >= box.y && y <= box.y + box.height) return true;

  const bowlHeight = box.height * P_BOWL_HEIGHT;
  const cx = box.x + box.stroke / 2;
  const cy = box.y + bowlHeight / 2;
  if (x < cx) return false;

  return (
    inEllipse(x, y, cx, cy, box.width - box.stroke / 2, bowlHeight / 2) &&
    !inEllipse(x, y, cx, cy, box.width - box.stroke / 2 - box.stroke, bowlHeight / 2 - box.stroke)
  );
};

/** The badge colour at a point in master coordinates, or null outside the badge. */
function badgeAt(x: number, y: number, size: number): Rgba | null {
  const centre = BADGE_CENTRE * size;
  const distance = Math.hypot(x - centre, y - centre);
  if (distance > BADGE_RING_RADIUS * size) return null;
  if (distance > BADGE_FILL_RADIUS * size) return { ...BADGE_RING, a: 255 };

  const width = GLYPH_WIDTH * size;
  const height = GLYPH_HEIGHT * size;
  const gap = GLYPH_GAP * size;
  const stroke = GLYPH_STROKE * size;
  const left = centre - (width * 2 + gap) / 2;
  const top = centre - height / 2;
  const glyphA: GlyphBox = { x: left, y: top, width, height, stroke };
  const glyphP: GlyphBox = { ...glyphA, x: left + width + gap };

  if (inGlyphA(x, y, glyphA) || inGlyphP(x, y, glyphP)) {
    return { ...BADGE_RING, a: 255 };
  }

  return { ...BADGE_FILL, a: 255 };
}

/** Tints one upstream pixel: black plate to fork orange, white artwork stays white. */
function tintPixel(r: number, g: number, b: number): Rgba {
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return {
    r: Math.round(PLATE_TINT.r + (255 - PLATE_TINT.r) * luminance),
    g: Math.round(PLATE_TINT.g + (255 - PLATE_TINT.g) * luminance),
    b: Math.round(PLATE_TINT.b + (255 - PLATE_TINT.b) * luminance),
    a: 255,
  };
}

/** Tints the plate and composites the badge, at the master's own resolution. */
function brandMaster(source: PNG): PNG {
  const size = source.width;
  const out = new PNG({ width: source.width, height: source.height });

  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const i = (source.width * y + x) << 2;
      const tinted = tintPixel(source.data[i]!, source.data[i + 1]!, source.data[i + 2]!);
      let r = tinted.r;
      let g = tinted.g;
      let b = tinted.b;
      let a = source.data[i + 3]!;

      // Supersample the badge so its curves land smoothly on the plate.
      let hits = 0;
      let badgeR = 0;
      let badgeG = 0;
      let badgeB = 0;
      for (let sy = 0; sy < BADGE_SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < BADGE_SUPERSAMPLE; sx += 1) {
          const sample = badgeAt(
            x + (sx + 0.5) / BADGE_SUPERSAMPLE,
            y + (sy + 0.5) / BADGE_SUPERSAMPLE,
            size,
          );
          if (!sample) continue;
          hits += 1;
          badgeR += sample.r;
          badgeG += sample.g;
          badgeB += sample.b;
        }
      }

      if (hits > 0) {
        const coverage = hits / (BADGE_SUPERSAMPLE * BADGE_SUPERSAMPLE);
        r = Math.round((badgeR / hits) * coverage + r * (1 - coverage));
        g = Math.round((badgeG / hits) * coverage + g * (1 - coverage));
        b = Math.round((badgeB / hits) * coverage + b * (1 - coverage));
        // The badge is opaque, so it also fills any transparent plate corner it
        // overhangs.
        a = Math.max(a, Math.round(255 * coverage));
      }

      out.data[i] = r;
      out.data[i + 1] = g;
      out.data[i + 2] = b;
      out.data[i + 3] = a;
    }
  }

  return out;
}

/** Alpha-weighted box downsample, so edge pixels do not pick up a dark halo. */
function resize(source: PNG, size: number): PNG {
  const out = new PNG({ width: size, height: size });
  const scaleX = source.width / size;
  const scaleY = source.height / size;

  for (let y = 0; y < size; y += 1) {
    const y0 = Math.floor(y * scaleY);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * scaleY));
    for (let x = 0; x < size; x += 1) {
      const x0 = Math.floor(x * scaleX);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * scaleX));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const i = (source.width * sy + sx) << 2;
          const alpha = source.data[i + 3]!;
          r += source.data[i]! * alpha;
          g += source.data[i + 1]! * alpha;
          b += source.data[i + 2]! * alpha;
          a += alpha;
          count += 1;
        }
      }
      const i = (size * y + x) << 2;
      out.data[i] = a === 0 ? 0 : Math.round(r / a);
      out.data[i + 1] = a === 0 ? 0 : Math.round(g / a);
      out.data[i + 2] = a === 0 ? 0 : Math.round(b / a);
      out.data[i + 3] = Math.round(a / count);
    }
  }

  return out;
}

/** Encodes one PNG per requested size, reusing the master where the size matches. */
function renderSizes(master: PNG, sizes: Iterable<number>): ReadonlyMap<number, Buffer> {
  return new Map(
    [...new Set(sizes)].map((size) => [
      size,
      PNG.sync.write(size === master.width ? master : resize(master, size)),
    ]),
  );
}

/** The upstream masters this generator brands. */
export const FORK_ICON_MASTER_PATHS = {
  universal: "assets/prod/black-universal-1024.png",
  macos: "assets/prod/black-macos-1024.png",
} as const;

export interface ForkIconArtifact {
  readonly relativePath: string;
  readonly contents: Buffer;
}

/**
 * Everything the fork commits, derived purely from the two masters, so a test
 * can re-derive it and compare against the committed bytes.
 */
export function buildForkIconArtifacts(masters: {
  readonly universal: Buffer;
  readonly macos: Buffer;
}): ReadonlyArray<ForkIconArtifact> {
  const universal = brandMaster(PNG.sync.read(masters.universal));
  const macos = brandMaster(PNG.sync.read(masters.macos));

  // Windows, Linux and the web read the edge-to-edge plate; macOS wants
  // upstream's grid padding, so its own master ships whole and the packager
  // derives the per-size renditions from it.
  const universalRenditions = renderSizes(universal, [...WINDOWS_ICON_SIZES, ...WEB_ICON_SIZES]);

  const windowsIco = encodePngIco(
    WINDOWS_ICON_SIZES.map((size) => ({ size, contents: universalRenditions.get(size)! })),
  );

  return [
    { relativePath: "assets/fork/fork-universal-1024.png", contents: PNG.sync.write(universal) },
    { relativePath: "assets/fork/fork-macos-1024.png", contents: PNG.sync.write(macos) },
    { relativePath: "assets/fork/fork-windows.ico", contents: windowsIco },
    { relativePath: "assets/fork/fork-web-favicon.ico", contents: windowsIco },
    {
      relativePath: "assets/fork/fork-web-favicon-16x16.png",
      contents: universalRenditions.get(16)!,
    },
    {
      relativePath: "assets/fork/fork-web-favicon-32x32.png",
      contents: universalRenditions.get(32)!,
    },
    {
      relativePath: "assets/fork/fork-web-apple-touch-180.png",
      contents: universalRenditions.get(180)!,
    },
  ];
}

/** Reads the masters and brands them, without writing anything. */
export const collectForkIconArtifacts = Effect.fn("collectForkIconArtifacts")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const read = (relativePath: string) =>
    fs.readFile(path.join(repoRoot, relativePath)).pipe(Effect.map((bytes) => Buffer.from(bytes)));

  return buildForkIconArtifacts({
    universal: yield* read(FORK_ICON_MASTER_PATHS.universal),
    macos: yield* read(FORK_ICON_MASTER_PATHS.macos),
  });
});

export const generateForkIcons = Effect.fn("generateForkIcons")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const artifacts = yield* collectForkIconArtifacts();

  for (const artifact of artifacts) {
    const target = path.join(repoRoot, artifact.relativePath);
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* fs.writeFile(target, artifact.contents);
    yield* Console.log(`wrote ${artifact.relativePath} (${artifact.contents.length} bytes)`);
  }
});

export const generateForkIconsCommand = Command.make("generate-fork-icons", {}, () =>
  generateForkIcons(),
).pipe(Command.withDescription("Regenerate this fork's tinted and badged app icons."));

if (import.meta.main) {
  Command.run(generateForkIconsCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
