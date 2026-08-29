#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pngToIco from "png-to-ico";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const assetsRoot = join(repositoryRoot, "desktop", "assets");
const source = join(assetsRoot, "icon.png");
const destination = join(assetsRoot, "icon.ico");

await mkdir(assetsRoot, { recursive: true });
const png = await readFile(source);
if (png.length < 8 || png.toString("hex", 0, 8) !== "89504e470d0a1a0a") {
  throw new Error("desktop_icon_must_be_png");
}

const ico = await pngToIco(source);
await writeFile(destination, ico);
console.log(`Wrote ${destination}`);
