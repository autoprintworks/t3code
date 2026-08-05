#!/usr/bin/env node
/**
 * Builds the rig the other three probes drive, for autoprintworks/t3code#47.
 *
 * The rig is an **isolated** T3 server: its own base dir, its own port, its own
 * settings.json. It never touches `~/.t3/userdata`, which is the developer's
 * live install.
 *
 * What it lays down:
 *   <rig>/work                a scratch git repo, used as the server's cwd
 *   <rig>/home                the server's base dir (T3CODE_HOME equivalent)
 *   <rig>/dumps               where captured child environments land
 *   <rig>/dump-env.cjs        a `--require` hook that writes one dump per child
 *   <rig>/home/userdata/settings.json
 *                             two provider instances, `spike_a` and `spike_b`
 *
 * The instances are the whole trick. Both use `driver: "codex"` with
 * `config.binaryPath` pointed at `node.exe` instead of the real codex binary,
 * and both carry an instance `environment` that sets `NODE_OPTIONS=--require
 * <hook>`. T3 therefore spawns a node process where it thinks it is spawning
 * codex, the hook runs first, and the child writes down its own view of its
 * environment before dying. That is the measurement.
 *
 * After running this, start the server and mint a token (see README).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RIG = process.env.SPIKE_RIG ?? "C:\\Users\\Glyn\\AppData\\Local\\Temp\\fm-inst-spike";
const NODE_BIN = process.env.SPIKE_NODE ?? process.execPath;

for (const dir of ["", "work", "home", "home/userdata", "dumps", "fmhome-a", "fmhome-b"]) {
  mkdirSync(join(RIG, dir), { recursive: true });
}

if (!existsSync(join(RIG, "work", ".git"))) {
  execFileSync("git", ["init", "-q"], { cwd: join(RIG, "work") });
  writeFileSync(join(RIG, "work", "README.md"), "rig for t3code#47\n");
  execFileSync("git", ["add", "-A"], { cwd: join(RIG, "work") });
  execFileSync(
    "git",
    ["-c", "user.email=spike@local", "-c", "user.name=spike", "commit", "-qm", "init"],
    { cwd: join(RIG, "work") },
  );
}

writeFileSync(
  join(RIG, "dump-env.cjs"),
  `const fs = require("fs");
const path = require("path");
const out = process.env.SPIKE_DUMP_DIR;
if (out) {
  const name = \`\${process.env.SPIKE_TAG ?? "untagged"}-\${process.pid}.json\`;
  try {
    fs.writeFileSync(path.join(out, name), JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      ppid: process.ppid,
      argv: process.argv,
      cwd: process.cwd(),
      FM_HOME: process.env.FM_HOME ?? null,
      CODEX_HOME: process.env.CODEX_HOME ?? null,
      hasPATH: Boolean(process.env.PATH || process.env.Path),
      pathLen: (process.env.PATH || process.env.Path || "").length,
      envKeyCount: Object.keys(process.env).length,
      SPIKE_TAG: process.env.SPIKE_TAG ?? null,
      sampleHostVars: ["USERPROFILE","APPDATA","SystemRoot","TEMP","COMSPEC"].filter((k) => process.env[k] !== undefined),
    }, null, 1));
  } catch {}
}
`,
);

const instance = (tag) => ({
  driver: "codex",
  displayName: `Spike ${tag}`,
  enabled: true,
  environment: [
    { name: "FM_HOME", value: join(RIG, `fmhome-${tag}`), sensitive: false },
    { name: "SPIKE_DUMP_DIR", value: join(RIG, "dumps"), sensitive: false },
    { name: "SPIKE_TAG", value: tag, sensitive: false },
    { name: "NODE_OPTIONS", value: `--require ${join(RIG, "dump-env.cjs")}`, sensitive: false },
  ],
  config: {
    enabled: true,
    binaryPath: NODE_BIN,
    homePath: "",
    shadowHomePath: "",
    launchArgs: "",
    customModels: [],
  },
});

writeFileSync(
  join(RIG, "home", "userdata", "settings.json"),
  JSON.stringify({ providerInstances: { spike_a: instance("a"), spike_b: instance("b") } }, null, 2),
);

console.log(`[rig] ${RIG}`);
console.log(`[node] ${NODE_BIN}`);
console.log("[next] start the server and mint a token, then run the probes — see README.md");
