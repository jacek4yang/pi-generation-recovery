import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  mkdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
  version: string;
  devDependencies: Record<string, string>;
};
const tarball = resolve("pi-generation-recovery-" + manifest.version + ".tgz");
const dir = await mkdtemp(join(tmpdir(), "generation-package-smoke-"));
try {
  const dependencies = {
    ...manifest.devDependencies,
    "pi-generation-recovery": "file:" + tarball,
  };
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ private: true, type: "module", dependencies }),
  );
  await writeFile(join(dir, ".npmrc"), "allow-git=root\n");
  execFileSync(
    "npm",
    ["install", "--no-audit", "--no-fund", "--ignore-scripts"],
    { cwd: dir, stdio: "inherit", timeout: 300000 },
  );
  const installed = JSON.parse(
    await readFile(
      join(dir, "node_modules/pi-generation-recovery/package.json"),
      "utf8",
    ),
  ) as { version: string; pi: { extensions: string[] } };
  assert.equal(installed.version, manifest.version);
  assert.deepEqual(installed.pi.extensions, ["./index.ts"]);
  // Version equality alone does not distinguish a stale same-version tarball.
  const sources = [
    "index.ts",
    ...(await readdir("src")).map((f) => "src/" + f),
  ];
  for (const file of sources) {
    const packaged = await readFile(
      join(dir, "node_modules/pi-generation-recovery", file),
    ).catch(() => undefined);
    assert(
      packaged?.equals(await readFile(file)),
      "Stale/missing packaged source: " + file + "; run npm pack first",
    );
  }
  await mkdir(join(dir, "test"));
  for (const file of await readdir("test")) {
    if (!file.endsWith(".ts")) continue;
    let content = await readFile(join("test", file), "utf8");
    for (const source of await readdir("src"))
      content = content.replaceAll(
        '"../src/' + source.replace(".ts", ".js") + '"',
        '"pi-generation-recovery/src/' + source + '"',
      );
    await writeFile(join(dir, "test", file), content);
  }
  const tests = (await readdir(join(dir, "test")))
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => "test/" + f);
  execFileSync(process.execPath, ["--import", "tsx", "--test", ...tests], {
    cwd: dir,
    stdio: "inherit",
    timeout: 120000,
    env: { ...process.env, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
  });
  console.log(
    JSON.stringify({
      packagedInstall: true,
      isolated: true,
      companionMatrix: true,
      version: manifest.version,
    }),
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
