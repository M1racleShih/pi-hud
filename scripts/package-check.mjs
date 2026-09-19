import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, dirname, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const npm = process.env.npm_execpath;
assert.ok(npm, "Run this script with npm run package:check");
const work = resolve(".tmp", `package-${process.pid}`);
mkdirSync(work, { recursive: true });
function run(args, cwd = process.cwd()) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
  return result.stdout;
}
try {
  const packed = JSON.parse(run([npm, "pack", "--offline", "--json", "--ignore-scripts", "--pack-destination", work]))[0];
  const names = packed.files.map((file) => file.path);
  for (const required of ["index.ts", "src/extension.ts", "src/footer.ts", "src/render.ts", "src/palette.ts", "src/state.ts", "README.md", "README.zh-CN.md", "LICENSE"]) assert.ok(names.includes(required), `Missing packed file: ${required}`);
  assert.ok(!names.some((name) => name.startsWith("node_modules/") || name.startsWith(".git/")));
  // Minimal regular-file TAR extraction for our own npm artifact, with traversal checks.
  const data = gunzipSync(readFileSync(join(work, packed.filename)));
  for (let offset = 0; offset + 512 <= data.length;) {
    const header = data.subarray(offset, offset + 512);
    const name = header.toString("utf8", 0, 100).replace(/\0.*$/s, "");
    if (!name) break;
    const prefix = header.toString("utf8", 345, 500).replace(/\0.*$/s, "");
    const path = prefix ? `${prefix}/${name}` : name;
    const size = parseInt(header.toString("ascii", 124, 136).replace(/\0.*$/s, "").trim() || "0", 8);
    assert.ok(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= data.length);
    const type = header[156];
    if (type === 0 || type === 48) {
      const target = resolve(work, path);
      assert.ok(target.startsWith(work + sep), "Tar path traversal");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, data.subarray(offset + 512, offset + 512 + size));
    } else assert.ok(type === 53 || type === 120 || type === 103, `Unsupported TAR entry: ${type}`);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  const root = join(work, "package");
  run([npm, "install", "--omit=dev", "--ignore-scripts", "--offline", "--no-audit", "--no-fund", "--package-lock=false", "--cache", join(work, "empty-cache")], root);
  run(["--experimental-strip-types", "--input-type=module", "-e", "const m = await import(process.argv[1]); if (typeof m.default !== 'function') process.exit(1)", pathToFileURL(join(root, "index.ts")).href], root);
  console.log(`PASS: ${packed.filename}; ${names.length} files; ${packed.size} bytes; production offline install and packed entry import`);
} finally { rmSync(work, { recursive: true, force: true }); }
