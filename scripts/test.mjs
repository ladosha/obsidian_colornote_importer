// Runs the unit tests in Node, without Obsidian: bundles test/*.test.ts with
// esbuild, then runs the bundles with node:test. The modules under test must
// not import "obsidian" (it has no runtime code, so bundling would fail).

import esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const outdir = join(repo, ".test-build");

rmSync(outdir, { recursive: true, force: true });

const entryPoints = readdirSync(join(repo, "test"))
	.filter((name) => name.endsWith(".test.ts"))
	.map((name) => join(repo, "test", name));

const result = await esbuild.build({
	absWorkingDir: repo,
	entryPoints,
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node20",
	outdir,
	outExtension: { ".js": ".mjs" },
	sourcemap: "inline",
	logLevel: "warning",
	metafile: true,
});

const outputs = Object.keys(result.metafile.outputs).map((file) => join(repo, file));
const run = spawnSync(process.execPath, ["--enable-source-maps", "--test", ...outputs], {
	cwd: repo,
	stdio: "inherit",
});
process.exit(run.status ?? 1);
