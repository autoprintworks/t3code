#!/usr/bin/env node
/**
 * Sub-questions 1 and 2 of autoprintworks/t3code#47: is settings.json a usable
 * write path, and does the registry reconcile live or need a restart?
 *
 * Adds a brand-new provider instance `spike_c` by writing settings.json
 * directly — no UI, no RPC, no CLI — and times how long until the registry has
 * built it. The signal is the instance's own status-probe child appearing in
 * the dump directory, because `ProviderInstanceRegistryLive.buildEntry` runs
 * `checkProvider` as part of the build.
 *
 * Also checks that the two pre-existing instances are *not* rebuilt, which is
 * what `makeReconcile`'s structural compare claims.
 *
 * Removes `spike_c` again at the end.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const RIG = process.env.SPIKE_RIG ?? "C:\\Users\\Glyn\\AppData\\Local\\Temp\\fm-inst-spike";
const SETTINGS = join(RIG, "home", "userdata", "settings.json");
const DUMPS = join(RIG, "dumps");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dumpNames = () => (existsSync(DUMPS) ? readdirSync(DUMPS) : []);

const before = new Set(dumpNames());
const settings = JSON.parse(readFileSync(SETTINGS, "utf8"));
const template = JSON.parse(JSON.stringify(settings.providerInstances.spike_a));
template.displayName = "Spike c";
for (const v of template.environment) {
  if (v.name === "FM_HOME") v.value = join(RIG, "fmhome-c");
  if (v.name === "SPIKE_TAG") v.value = "c";
}
settings.providerInstances.spike_c = template;

const writtenAt = Date.now();
writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));
console.log(`[write] spike_c added to settings.json at ${new Date(writtenAt).toISOString()}`);

let seenAt = null;
while (Date.now() - writtenAt < 60_000) {
  const fresh = dumpNames().filter((n) => !before.has(n));
  const c = fresh.find((n) => n.startsWith("c-"));
  if (c) {
    seenAt = Date.now();
    const d = JSON.parse(readFileSync(join(DUMPS, c), "utf8"));
    console.log(`[built] ${c} after ${seenAt - writtenAt} ms`);
    console.log(`        FM_HOME=${d.FM_HOME} cwd=${d.cwd} envKeys=${d.envKeyCount} hasPATH=${d.hasPATH}`);
    const others = fresh.filter((n) => !n.startsWith("c-"));
    console.log(`[untouched] other instances that also respawned: ${others.length === 0 ? "none" : others.join(", ")}`);
    break;
  }
  await sleep(100);
}
if (!seenAt) console.log("[!] spike_c never produced a child within 60s");

// clean up
const restored = JSON.parse(readFileSync(SETTINGS, "utf8"));
delete restored.providerInstances.spike_c;
writeFileSync(SETTINGS, JSON.stringify(restored, null, 2));
console.log("[cleanup] spike_c removed from settings.json");
