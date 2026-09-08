import { ClaudeSettings } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  buildClaudeCapabilitiesProbeQueryOptions,
  CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES,
  isLegacyClaudeModel,
  probeClaudeCapabilities,
} from "./ClaudeProvider.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

it("keeps only the Claude 5 family out of legacy models", () => {
  assert.deepStrictEqual(
    ["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-opus-4-8"].map((model) => [
      model,
      isLegacyClaudeModel(model),
    ]),
    [
      ["claude-fable-5", false],
      ["claude-opus-5", false],
      ["claude-sonnet-5", false],
      ["claude-opus-4-8", true],
    ],
  );
});

it("isolates Claude capability probes without dropping workspace setting sources", () => {
  const abortController = new AbortController();
  const options = buildClaudeCapabilitiesProbeQueryOptions({
    executablePath: "/usr/bin/claude",
    abortController,
    environment: {
      HOME: "/home/user",
      ENABLE_CLAUDEAI_MCP_SERVERS: "true",
    },
    cwd: "/workspace/project",
  });

  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.strictMcpConfig, true);
  assert.equal(options.cwd, "/workspace/project");
  assert.deepEqual(options.settingSources, [...CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES]);
  assert.deepEqual(options.allowedTools, []);
  assert.equal(options.persistSession, false);
  assert.equal(options.pathToClaudeCodeExecutable, "/usr/bin/claude");
  assert.equal(options.abortController, abortController);
  assert.equal(options.env?.HOME, "/home/user");
  assert.equal(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
});

it.layer(NodeServices.layer)("Claude capability probe SDK boundary", (it) => {
  it.effect("serializes strict no-MCP options and still resolves account capabilities", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-probe-sdk-" });
      const executablePath = path.join(tempDir, "fake-claude.mjs");
      const invocationPath = path.join(tempDir, "invocation.json");
      const workspaceCwd = path.join(tempDir, "workspace");
      yield* fs.makeDirectory(workspaceCwd, { recursive: true });

      yield* fs.writeFileString(
        executablePath,
        [
          "#!/usr/bin/env node",
          'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
          'import { createInterface } from "node:readline";',
          "const args = process.argv.slice(2);",
          'const mcpConfigIndex = args.indexOf("--mcp-config");',
          "const rawMcpConfig = mcpConfigIndex >= 0 ? args[mcpConfigIndex + 1] : undefined;",
          "let mcpConfig;",
          "if (rawMcpConfig) {",
          '  const contents = existsSync(rawMcpConfig) ? readFileSync(rawMcpConfig, "utf8") : rawMcpConfig;',
          "  try { mcpConfig = JSON.parse(contents); } catch { mcpConfig = contents; }",
          "}",
          "writeFileSync(process.env.T3_PROBE_INVOCATION_PATH, JSON.stringify({",
          "  args,",
          "  cwd: process.cwd(),",
          "  connectorEnv: process.env.ENABLE_CLAUDEAI_MCP_SERVERS,",
          "  mcpConfig,",
          "}));",
          "const lines = createInterface({ input: process.stdin });",
          'lines.on("line", (line) => {',
          "  const message = JSON.parse(line);",
          '  if (message.type !== "control_request" || message.request?.subtype !== "initialize") return;',
          "  process.stdout.write(JSON.stringify({",
          '    type: "control_response",',
          "    response: {",
          '      subtype: "success",',
          "      request_id: message.request_id,",
          "      response: {",
          '        commands: [{ name: "review", description: "Review changes", argumentHint: "[path]" }],',
          "        agents: [],",
          '        output_style: "default",',
          '        available_output_styles: ["default"],',
          "        models: [],",
          '        account: { email: "dev@example.com", subscriptionType: "pro", tokenSource: "oauth" },',
          "      },",
          "    },",
          '  }) + "\\n");',
          "});",
          // The SDK's abort does not reap this stub, so it retires itself. The probe answers in well
          // under a second; a stub that outlives the test holds its working directory open, and
          // Windows refuses to remove a directory that is a live process's working directory.
          "setTimeout(() => process.exit(0), 3_000);",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(executablePath, 0o755);

      const capabilities = yield* probeClaudeCapabilities(
        decodeClaudeSettings({ binaryPath: executablePath }),
        {
          ...process.env,
          T3_PROBE_INVOCATION_PATH: invocationPath,
          ENABLE_CLAUDEAI_MCP_SERVERS: "true",
        },
        workspaceCwd,
      );

      assert.deepEqual(capabilities, {
        _tag: "Succeeded",
        probe: {
          email: "dev@example.com",
          subscriptionType: "pro",
          tokenSource: "oauth",
          apiProvider: undefined,
          slashCommands: [
            {
              name: "review",
              description: "Review changes",
              input: { hint: "[path]" },
            },
          ],
        },
      });

      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const invocation = JSON.parse(yield* fs.readFileString(invocationPath)) as {
        readonly args: ReadonlyArray<string>;
        readonly cwd: string;
        readonly connectorEnv: string;
        readonly mcpConfig: unknown;
      };
      assert.equal(invocation.cwd, yield* fs.realPath(workspaceCwd));
      assert.equal(invocation.connectorEnv, "false");
      assert.equal(invocation.args.includes("--strict-mcp-config"), true);
      assert.equal(invocation.args.includes("--mcp-config"), false);
      assert.equal(invocation.mcpConfig, undefined);

      assert.equal(invocation.args.includes("--setting-sources=user,project,local"), true);

      // The probe aborts its child but nothing reaps it, and Windows refuses to remove a directory
      // that is a live process's working directory. Take the workspace down here, once the stub has
      // retired itself, so scoped cleanup of the parent temp directory cannot race that exit.
      // it.effect runs on the test clock, so the wait between attempts uses a real timer.
      const waitForStubExit = Effect.promise(
        () => new Promise<void>((resolve) => setTimeout(resolve, 250)),
      );
      let workspaceRemoved = false;
      for (let attempt = 0; attempt < 40 && !workspaceRemoved; attempt += 1) {
        workspaceRemoved = yield* fs.remove(workspaceCwd, { recursive: true }).pipe(
          Effect.as(true),
          Effect.catch(() => waitForStubExit.pipe(Effect.as(false))),
        );
      }
      assert.equal(workspaceRemoved, true);
    }).pipe(Effect.scoped),
  );
});
