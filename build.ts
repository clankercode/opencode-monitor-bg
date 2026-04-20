import { mkdirSync } from "fs";

mkdirSync("dist", { recursive: true });

await Bun.build({
  entrypoints: ["./monitor.ts"],
  outdir: "./dist",
  target: "bun",
  format: "esm",
  packages: "bundle",
  naming: "monitor.js",
});
