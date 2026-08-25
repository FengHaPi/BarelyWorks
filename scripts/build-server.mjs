import fs from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const projectRoot = path.resolve(import.meta.dirname, "..");
const outputDirectory = path.resolve(projectRoot, "dist", "server");
if (path.dirname(outputDirectory) !== path.join(projectRoot, "dist")) {
  throw new Error("Refusing to clean an unexpected build directory");
}

await fs.rm(outputDirectory, { recursive: true, force: true });
await fs.mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [path.join(projectRoot, "src", "server.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: path.join(outputDirectory, "server.js"),
  sourcemap: true,
  packages: "external",
  target: "node22",
});
