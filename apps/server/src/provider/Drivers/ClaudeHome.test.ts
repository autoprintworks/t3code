// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  applyTurnEnvironment,
  claudeSignedOutMessage,
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

const decodeEnvironment = Schema.decodeUnknownSync(ProviderInstanceEnvironment);

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("uses the process home when no Claude home override is configured", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* resolveClaudeHomePath({ homePath: "" })).toBe(resolved);
        expect(yield* makeClaudeEnvironment({ homePath: "" })).toBe(process.env);
      }),
    );

    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(`claude:home:${resolved}`);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it("points the signed-out hint at the configured Claude home", () => {
      expect(claudeSignedOutMessage({ configDir: undefined, cwd: "/synthetic" })).toContain(
        "run `claude auth login`",
      );
      const configDir = "/synthetic/Claude work's $literal";
      const message = claudeSignedOutMessage({ configDir, cwd: "/synthetic/project" });
      expect(message).toContain(`CLAUDE_CONFIG_DIR set to "${configDir}"`);
      expect(message).not.toContain("CLAUDE_CONFIG_DIR=");
      expect(message).toContain("then start a new thread");
    });

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );

    it.effect("keeps continuation compatible across instances with the same Claude HOME", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" })).toBe(
          `claude:home:${resolved}`,
        );
      }),
    );
  });

  describe("turn environment overlay", () => {
    /** Turn entries, decoded through the contract the daemon sends them on. */
    const entries = (...pairs: ReadonlyArray<readonly [string, string]>) =>
      decodeEnvironment(pairs.map(([name, value]) => ({ name, value })));

    it("returns the instance environment unchanged when the turn carried none", () => {
      const baseEnv = { FM_UNIT: "instance" };
      expect(applyTurnEnvironment(baseEnv, undefined)).toBe(baseEnv);
      expect(applyTurnEnvironment(baseEnv, entries())).toBe(baseEnv);
    });

    it("merges turn entries over the instance environment", () => {
      const merged = applyTurnEnvironment(
        { FM_UNIT: "instance", KEPT: "instance" },
        entries(["FM_UNIT", "unit-7"], ["FM_DECLARE_HOME", "/opt/fm/home"]),
      );
      expect(merged.FM_UNIT).toBe("unit-7");
      expect(merged.FM_DECLARE_HOME).toBe("/opt/fm/home");
      expect(merged.KEPT).toBe("instance");
    });

    it("puts a PATH entry in front of the inherited PATH", () => {
      const merged = applyTurnEnvironment(
        { PATH: `/usr/bin${NodePath.delimiter}/bin` },
        entries(["PATH", "/opt/fm/bin"]),
      );
      expect(merged.PATH).toBe(`/opt/fm/bin${NodePath.delimiter}/usr/bin${NodePath.delimiter}/bin`);
    });

    it("writes the PATH prefix back to the key the base environment uses", () => {
      // Windows spells the variable `Path`. Two keys that differ only in case
      // would reach the child as two variables, and the CLI would read one.
      const merged = applyTurnEnvironment({ Path: "/usr/bin" }, entries(["PATH", "/opt/fm/bin"]));
      expect(merged.Path).toBe(`/opt/fm/bin${NodePath.delimiter}/usr/bin`);
      expect(Object.keys(merged).filter((key) => key.toUpperCase() === "PATH")).toEqual(["Path"]);
    });

    it("uses the PATH entry alone when nothing was inherited", () => {
      expect(applyTurnEnvironment({}, entries(["PATH", "/opt/fm/bin"])).PATH).toBe("/opt/fm/bin");
      expect(applyTurnEnvironment({ PATH: "" }, entries(["PATH", "/opt/fm/bin"])).PATH).toBe(
        "/opt/fm/bin",
      );
    });

    it("does not change the instance environment it was given", () => {
      const baseEnv = { PATH: "/usr/bin", FM_UNIT: "instance" };
      applyTurnEnvironment(baseEnv, entries(["PATH", "/opt/fm/bin"], ["FM_UNIT", "unit-7"]));
      expect(baseEnv).toEqual({ PATH: "/usr/bin", FM_UNIT: "instance" });
    });
  });
});
