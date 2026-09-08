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
 * Outputs (all committed):
 *   assets/fork/fork-universal-1024.png   Linux and Windows master
 *   assets/fork/fork-macos-1024.png       macOS master, keeping upstream's grid padding
 *   assets/fork/fork-windows.ico          16, 24, 32, 48, 64, 128, 256
 *   apps/desktop/resources/icon.png, icon.ico, icon.icns
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

/** Samples per output pixel edge when rasterising the badge. */
const BADGE_SUPERSAMPLE = 3;

interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

const inEllipse = (x: number, y: number, cx: number, cy: number, rx: number, ry: number) =>
  rx > 0 && ry > 0 && ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;

const inTriangle = (
  x: number,
  y: number,
  apexX: number,
  apexY: number,
  baseLeftX: number,
  baseRightX: number,
  baseY: number,
) => {
  if (y < apexY || y > baseY) return false;
  const t = (y - apexY) / (baseY - apexY);
  return x >= apexX + (baseLeftX - apexX) * t && x <= apexX + (baseRightX - apexX) * t;
};

/** Upper-case "A", drawn as a triangular outline with a crossbar. */
const inGlyphA = (x: number, y: number, x0: number, y0: number, w: number, h: number, t: number) => {
  const apexX = x0 + w / 2;
  const baseY = y0 + h;
  if (!inTriangle(x, y, apexX, y0, x0, x0 + w, baseY)) return false;
  const crossbarCentre = baseY - h * 0.34;
  if (Math.abs(y - crossbarCentre) <= t / 2) return true;
  return !inTriangle(x, y, apexX, y0 + t * 1.7, x0 + t * 1.2, x0 + w - t * 1.2, baseY);
};

/** Upper-case "P", drawn as a stem plus a half-elliptical bowl. */
const inGlyphP = (x: number, y: number, x0: number, y0: number, w: number, h: number, t: number) => {
  if (x >= x0 && x <= x0 + t && y >= y0 && y <= y0 + h) return true;
  const bowlHeight = h * 0.62;
  const cy = y0 + bowlHeight / 2;
  if (x < x0 + t / 2) return false;
  return (
    inEllipse(x, y, x0 + t / 2, cy, w - t / 2, bowlHeight / 2) &&
    !inEllipse(x, y, x0 + t / 2, cy, w - t / 2 - t, bowlHeight / 2 - t)
  );
};

/** The badge colour at a point in master coordinates, or null outside the badge. */
function badgeAt(x: number, y: number, size: number): Rgba | null {
  const centre = BADGE_CENTRE * size;
  const distance = Math.hypot(x - centre, y - centre);
  if (distance > BADGE_RING_RADIUS * size) return null;
  if (distance > BADGE_FILL_RADIUS * size) return { ...BADGE_RING, a: 255 };

  const glyphWidth = GLYPH_WIDTH * size;
  const glyphHeight = GLYPH_HEIGHT * size;
  const glyphGap = GLYPH_GAP * size;
  const stroke = GLYPH_STROKE * size;
  const left = centre - (glyphWidth * 2 + glyphGap) / 2;
  const top = centre - glyphHeight / 2;

  if (
    inGlyphA(x, y, left, top, glyphWidth, glyphHeight, stroke) ||
    inGlyphP(x, y, left + glyphWidth + glyphGap, top, glyphWidth, glyphHeight, stroke)
  ) {
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

/**
 * ICNS entries this fork ships. Each holds a PNG rendition at the size Apple
 * assigns to that four-character type.
 */
const ICNS_ENTRIES = [
  ["icp4", 16],
  ["icp5", 32],
  ["ic11", 32],
  ["ic12", 64],
  ["ic07", 128],
  ["ic08", 256],
  ["ic13", 256],
  ["ic09", 512],
  ["ic14", 512],
  ["ic10", 1024],
] as const satisfies ReadonlyArray<readonly [string, number]>;

function encodeIcns(renditions: ReadonlyMap<number, Buffer>): Buffer {
  const chunks = ICNS_ENTRIES.map(([type, size]) => {
    const png = renditions.get(size);
    if (!png) throw new Error(`Missing a ${size}x${size} rendition for ICNS type ${type}.`);
    const header = Buffer.alloc(8);
    header.write(type, 0, "ascii");
    header.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([header, png]);
  });

  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}

export const generateForkIcons = Effect.fn("generateForkIcons")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));

  const write = (relativePath: string, contents: Buffer) =>
    Effect.gen(function* () {
      const target = path.join(repoRoot, relativePath);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFile(target, contents);
      yield* Console.log(`wrote ${relativePath} (${contents.length} bytes)`);
    });

  const readMaster = (relativePath: string) =>
    fs
      .readFile(path.join(repoRoot, relativePath))
      .pipe(Effect.map((bytes) => brandMaster(PNG.sync.read(Buffer.from(bytes)))));

  const universal = yield* readMaster("assets/prod/black-universal-1024.png");
  const macos = yield* readMaster("assets/prod/black-macos-1024.png");

  const renditionSizes = [
    ...new Set<number>([...WINDOWS_ICON_SIZES, ...ICNS_ENTRIES.map(([, size]) => size), 512]),
  ];
  const renditions = new Map<number, Buffer>(
    renditionSizes.map((size) => [
      size,
      PNG.sync.write(size === universal.width ? universal : resize(universal, size)),
    ]),
  );

  const windowsIco = encodePngIco(
    WINDOWS_ICON_SIZES.map((size) => ({ size, contents: renditions.get(size)! })),
  );

  yield* write("assets/fork/fork-universal-1024.png", PNG.sync.write(universal));
  yield* write("assets/fork/fork-macos-1024.png", PNG.sync.write(macos));
  yield* write("assets/fork/fork-windows.ico", windowsIco);
  yield* write("apps/desktop/resources/icon.ico", windowsIco);
  yield* write("apps/desktop/resources/icon.png", renditions.get(512)!);
  yield* write("apps/desktop/resources/icon.icns", encodeIcns(renditions));
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
