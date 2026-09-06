import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  discoverClaudeSkills,
  findLeadingSkillMention,
  formatInlinedSkillPrompt,
  hasLeadingSkillMention,
  readClaudeSkillBody,
} from "./ClaudeSkills.ts";

const writeSkill = Effect.fn(function* (
  skillsDir: string,
  directoryName: string,
  contents: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillDir = path.join(skillsDir, directoryName);
  yield* fs.makeDirectory(skillDir, { recursive: true });
  yield* fs.writeFileString(path.join(skillDir, "SKILL.md"), contents);
});

it.layer(NodeServices.layer)("discoverClaudeSkills", (it) => {
  it.effect("discovers user and project skills with frontmatter metadata", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "codex-review",
        [
          "---",
          "name: codex-review",
          "description: Ask Codex for a review.",
          "---",
          "",
          "# Body",
        ].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Deploy the app.", "---", "", "# Deploy"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace);

      assert.deepEqual(skills, [
        {
          name: "codex-review",
          path: path.join(configDir, "skills", "codex-review", "SKILL.md"),
          enabled: true,
          scope: "user",
          description: "Ask Codex for a review.",
        },
        {
          name: "deploy",
          path: path.join(workspace, ".claude", "skills", "deploy", "SKILL.md"),
          enabled: true,
          scope: "project",
          description: "Deploy the app.",
        },
      ]);
    }),
  );

  it.effect("prefers project skills over user skills on name collisions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "deploy",
        ["---", "name: deploy", "description: User deploy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Project deploy.", "---"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace);

      assert.equal(skills.length, 1);
      assert.equal(skills[0]?.scope, "project");
      assert.equal(skills[0]?.description, "Project deploy.");
    }),
  );

  it.effect("falls back to the directory name and skips malformed frontmatter", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const skillsDir = path.join(configDir, "skills");

      yield* writeSkill(skillsDir, "no-frontmatter", "# Just a heading\n");
      yield* writeSkill(skillsDir, "broken-yaml", "---\nname: [unclosed\n---\n");
      // A stray file (not a directory with SKILL.md) must be skipped.
      yield* fs.makeDirectory(skillsDir, { recursive: true });
      yield* fs.writeFileString(path.join(skillsDir, "README.md"), "not a skill");

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, undefined);

      // A skill with no frontmatter falls back to its directory name; a skill
      // whose frontmatter fails to parse is skipped entirely (Claude Code
      // won't load it either).
      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["no-frontmatter"],
      );
      assert.equal(skills[0]?.description, undefined);
    }),
  );

  it.effect("honors CLAUDE_CONFIG_DIR from the environment when homePath is unset", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const environmentConfigDir = path.join(tempDir, "env-config");

      yield* writeSkill(
        path.join(environmentConfigDir, "skills"),
        "env-skill",
        ["---", "name: env-skill", "description: From env config dir.", "---"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: "" }, undefined, {
        CLAUDE_CONFIG_DIR: environmentConfigDir,
      });

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["env-skill"],
      );

      // An explicit homePath wins over the environment variable, matching
      // makeClaudeEnvironment which overwrites CLAUDE_CONFIG_DIR for the CLI.
      const explicitHome = path.join(tempDir, "explicit-home");
      yield* writeSkill(
        path.join(explicitHome, "skills"),
        "explicit-skill",
        ["---", "name: explicit-skill", "---"].join("\n"),
      );
      const explicitSkills = yield* discoverClaudeSkills({ homePath: explicitHome }, undefined, {
        CLAUDE_CONFIG_DIR: environmentConfigDir,
      });
      assert.deepEqual(
        explicitSkills.map((skill) => skill.name),
        ["explicit-skill"],
      );
    }),
  );

  it.effect("resolves a relative CLAUDE_CONFIG_DIR against the workspace cwd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const workspace = path.join(tempDir, "workspace");
      yield* fs.makeDirectory(workspace, { recursive: true });

      // The spawned CLI resolves a relative CLAUDE_CONFIG_DIR against its own
      // cwd (the workspace), so discovery must do the same.
      yield* writeSkill(
        path.join(workspace, "relative-config", "skills"),
        "relative-skill",
        ["---", "name: relative-skill", "---"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: "" }, workspace, {
        CLAUDE_CONFIG_DIR: "relative-config",
      });

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["relative-skill"],
      );
      assert.equal(skills[0]?.scope, "user");
    }),
  );

  it.effect("returns an empty list when no skill roots exist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });

      const skills = yield* discoverClaudeSkills(
        { homePath: path.join(tempDir, "missing-home") },
        path.join(tempDir, "missing-workspace"),
      );

      assert.deepEqual(skills, []);
    }),
  );
});

describe("findLeadingSkillMention", () => {
  const skills = [
    { name: "to-spec", path: "/skills/to-spec/SKILL.md" },
    { name: "code-review", path: "/skills/code-review/SKILL.md" },
  ];

  const rewrite = (text: string) => {
    const mention = findLeadingSkillMention(text, skills);
    return mention ? `/${mention.skill.name}${mention.rest}` : text;
  };

  it("matches a chip-only message, leaving nothing after the command", () => {
    const mention = findLeadingSkillMention("$to-spec", skills);
    assert.equal(mention?.skill.name, "to-spec");
    assert.equal(mention?.rest, "");
    assert.equal(rewrite("$to-spec"), "/to-spec");
  });

  it("keeps the rest of the message after the slash command", () => {
    assert.equal(findLeadingSkillMention("$to-spec route A", skills)?.rest, " route A");
    assert.equal(rewrite("$to-spec route A"), "/to-spec route A");
  });

  // The `/` menu lists the same skills as `/skill:<Display Name>` rows and
  // inserts the slash form, which must resolve to the same skill.
  it("matches the slash form the slash menu inserts", () => {
    assert.equal(findLeadingSkillMention("/to-spec route A", skills)?.skill.name, "to-spec");
    assert.equal(rewrite("/to-spec route A"), "/to-spec route A");
  });

  it("keeps a multi-line message intact below the command line", () => {
    assert.equal(rewrite("$to-spec route A\nsecond line"), "/to-spec route A\nsecond line");
  });

  it("leaves an unknown skill name alone", () => {
    assert.equal(findLeadingSkillMention("$not-a-skill route A", skills), null);
    assert.equal(rewrite("$not-a-skill route A"), "$not-a-skill route A");
    // A provider slash command that is not a skill must pass through too.
    assert.equal(findLeadingSkillMention("/compact", skills), null);
  });

  it("leaves a mention that is not at the start alone", () => {
    assert.equal(findLeadingSkillMention("please run $to-spec", skills), null);
  });

  it("leaves a bare dollar sign and a partial token alone", () => {
    assert.equal(findLeadingSkillMention("$ to-spec", skills), null);
    assert.equal(findLeadingSkillMention("$to-spectacular", skills), null);
  });

  it("leaves everything alone when no skills were discovered", () => {
    assert.equal(findLeadingSkillMention("$to-spec", []), null);
  });
});

describe("hasLeadingSkillMention", () => {
  it("is true only for a message that starts with a `$name` or `/name` token", () => {
    assert.equal(hasLeadingSkillMention("$to-spec route A"), true);
    assert.equal(hasLeadingSkillMention("$to-spec"), true);
    assert.equal(hasLeadingSkillMention("/to-spec route A"), true);
    assert.equal(hasLeadingSkillMention("please run $to-spec"), false);
    assert.equal(hasLeadingSkillMention("$ to-spec"), false);
    assert.equal(hasLeadingSkillMention("just some text"), false);
  });
});

describe("formatInlinedSkillPrompt", () => {
  const skill = { name: "to-spec", path: "/skills/to-spec/SKILL.md" };

  it("names the skill and its file, then the instructions", () => {
    const prompt = formatInlinedSkillPrompt({ skill, body: "# Body", rest: "" });
    assert.equal(prompt.includes("Run the to-spec skill."), true);
    assert.equal(prompt.includes("/skills/to-spec/SKILL.md"), true);
    assert.equal(prompt.endsWith("# Body"), true);
  });

  it("appends the rest of the message below a separator", () => {
    const prompt = formatInlinedSkillPrompt({ skill, body: "# Body", rest: " route A" });
    assert.equal(prompt.endsWith("# Body\n\n---\n\nroute A"), true);
  });
});

it.layer(NodeServices.layer)("readClaudeSkillBody", (it) => {
  it.effect("returns the body with the frontmatter stripped", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skill-body-" });
      const skillsDir = path.join(tempDir, "skills");

      yield* writeSkill(
        skillsDir,
        "to-spec",
        ["---", "name: to-spec", "description: Turn notes into a spec.", "---", "", "# Body"].join(
          "\n",
        ),
      );

      const body = yield* readClaudeSkillBody(path.join(skillsDir, "to-spec", "SKILL.md"));

      assert.equal(body, "# Body");
    }),
  );

  it.effect("returns undefined for a missing or empty skill file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skill-body-" });
      const skillsDir = path.join(tempDir, "skills");

      yield* writeSkill(skillsDir, "empty", ["---", "name: empty", "---", ""].join("\n"));

      assert.equal(
        yield* readClaudeSkillBody(path.join(skillsDir, "empty", "SKILL.md")),
        undefined,
      );
      assert.equal(yield* readClaudeSkillBody(path.join(skillsDir, "gone", "SKILL.md")), undefined);
    }),
  );
});
