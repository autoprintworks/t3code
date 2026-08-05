#!/usr/bin/env node
/**
 * Sub-question 6 of autoprintworks/t3code#47: is `sensitive`/`valueRedacted`
 * in the way?
 *
 * `FM_HOME` is a path, not a secret, so the interesting question is only
 * whether a *non*-sensitive value survives the round trip unredacted, and
 * what happens if a secondmate home ever needs a sensitive sibling
 * (a token, say). This adds one `sensitive: true` variable alongside the
 * non-sensitive ones by writing settings.json directly, and reads back both
 * the file and the child's own environment.
 *
 * Extends the dump hook with the two extra names first, so the child reports
 * them. Restores the original settings and hook on the way out.
 */
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RIG = process.env.SPIKE_RIG ?? "C:\\Users\\Glyn\\AppData\\Local\\Temp\\fm-inst-spike";
const SETTINGS = join(RIG, "home", "userdata", "settings.json");
const HOOK = join(RIG, "dump-env.cjs");

if (process.argv.includes("--restore")) {
  copyFileSync(`${SETTINGS}.bak`, SETTINGS);
  copyFileSync(`${HOOK}.bak`, HOOK);
  console.log("[restored]");
  process.exit(0);
}

copyFileSync(SETTINGS, `${SETTINGS}.bak`);
copyFileSync(HOOK, `${HOOK}.bak`);

const hook = readFileSync(HOOK, "utf8").replace(
  "      SPIKE_TAG: process.env.SPIKE_TAG ?? null,",
  "      SPIKE_TAG: process.env.SPIKE_TAG ?? null,\n" +
    "      SPIKE_SECRET: process.env.SPIKE_SECRET ?? null,",
);
writeFileSync(HOOK, hook);

const settings = JSON.parse(readFileSync(SETTINGS, "utf8"));
settings.providerInstances.spike_a.environment.push({
  name: "SPIKE_SECRET",
  value: "s3cret-value-0047",
  sensitive: true,
});
writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));
console.log("[settings] added SPIKE_SECRET (sensitive: true) to spike_a by direct file write");

await new Promise((r) => setTimeout(r, 6000));

const onDisk = JSON.parse(readFileSync(SETTINGS, "utf8"));
const entry = onDisk.providerInstances.spike_a.environment.find((v) => v.name === "SPIKE_SECRET");
console.log(`[settings.json after reconcile] ${JSON.stringify(entry)}`);

console.log("\nNow run:  node probe-session-env.mjs");
console.log("and read SPIKE_SECRET out of the SESSION dump.\n");
console.log("Restore with:  node probe-sensitive-roundtrip.mjs --restore");
