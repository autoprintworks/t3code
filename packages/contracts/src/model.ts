import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

export const ProviderOptionDescriptorType = Schema.Literals(["select", "boolean"]);
export type ProviderOptionDescriptorType = typeof ProviderOptionDescriptorType.Type;

export const ProviderOptionChoice = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  isDefault: Schema.optional(Schema.Boolean),
});
export type ProviderOptionChoice = typeof ProviderOptionChoice.Type;

const ProviderOptionDescriptorBase = {
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
} as const;

export const SelectProviderOptionDescriptor = Schema.Struct({
  ...ProviderOptionDescriptorBase,
  type: Schema.Literal("select"),
  options: Schema.Array(ProviderOptionChoice),
  currentValue: Schema.optional(TrimmedNonEmptyString),
  promptInjectedValues: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
export type SelectProviderOptionDescriptor = typeof SelectProviderOptionDescriptor.Type;

export const BooleanProviderOptionDescriptor = Schema.Struct({
  ...ProviderOptionDescriptorBase,
  type: Schema.Literal("boolean"),
  currentValue: Schema.optional(Schema.Boolean),
});
export type BooleanProviderOptionDescriptor = typeof BooleanProviderOptionDescriptor.Type;

export const ProviderOptionDescriptor = Schema.Union([
  SelectProviderOptionDescriptor,
  BooleanProviderOptionDescriptor,
]);
export type ProviderOptionDescriptor = typeof ProviderOptionDescriptor.Type;

export const ProviderOptionSelectionValue = Schema.Union([TrimmedNonEmptyString, Schema.Boolean]);
export type ProviderOptionSelectionValue = typeof ProviderOptionSelectionValue.Type;

export const ProviderOptionSelection = Schema.Struct({
  id: TrimmedNonEmptyString,
  value: ProviderOptionSelectionValue,
});
export type ProviderOptionSelection = typeof ProviderOptionSelection.Type;

/**
 * Legacy on-disk shape for provider option selections, kept readable by the
 * decoder so we can tolerate stored data written before the v3 array shape.
 *
 * Persisted historically as `{ effort: "max", fastMode: true, ... }` inside
 * `modelSelection.options`. Migration 026 rewrites stored rows to the
 * canonical array shape, but we still see the legacy form in:
 *   - `settings.json` files from older client builds,
 *   - SQLite databases that have not yet run migration 026,
 *   - any future regression that re-introduces the legacy shape.
 */
const LegacyProviderOptionSelectionsObject = Schema.Record(Schema.String, Schema.Unknown);

const ProviderOptionSelectionsFromLegacyObject = LegacyProviderOptionSelectionsObject.pipe(
  Schema.decodeTo(
    Schema.Array(ProviderOptionSelection),
    SchemaTransformation.transformOrFail({
      decode: (record) => Effect.succeed(coerceLegacyOptionsObjectToArray(record)),
      encode: (selections) => Effect.succeed(canonicalSelectionsToLegacyObject(selections)),
    }),
  ),
);

/**
 * Schema for the `options` field of every `ModelSelection` variant.
 *
 * Accepts both:
 *   - the canonical array shape `Array<{ id, value }>` (preferred), and
 *   - the legacy object shape `Record<string, string | boolean | …>` from
 *     pre-migration data.
 *
 * Always normalizes to the canonical array on decode and re-encodes as the
 * canonical array, so any legacy storage gets cleaned up the next time the
 * containing record is written back.
 */
export const ProviderOptionSelections = Schema.Union([
  Schema.Array(ProviderOptionSelection),
  ProviderOptionSelectionsFromLegacyObject,
]);
export type ProviderOptionSelections = typeof ProviderOptionSelections.Type;

function coerceLegacyOptionsObjectToArray(
  record: Record<string, unknown>,
): ReadonlyArray<ProviderOptionSelection> {
  const entries: Array<ProviderOptionSelection> = [];
  for (const [rawKey, rawValue] of Object.entries(record)) {
    const id = typeof rawKey === "string" ? rawKey.trim() : "";
    if (id.length === 0) continue;
    if (typeof rawValue === "string") {
      const trimmed = rawValue.trim();
      if (trimmed.length > 0) entries.push({ id, value: trimmed });
    } else if (typeof rawValue === "boolean") {
      entries.push({ id, value: rawValue });
    }
    // Drop anything else (numbers, null, nested objects/arrays) to match the
    // permissive normalization performed by migration 026.
  }
  return entries;
}

function canonicalSelectionsToLegacyObject(
  selections: ReadonlyArray<ProviderOptionSelection>,
): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const { id, value } of selections) {
    out[id] = value;
  }
  return out;
}

export const ModelCapabilities = Schema.Struct({
  optionDescriptors: Schema.optional(Schema.Array(ProviderOptionDescriptor)),
});
export type ModelCapabilities = typeof ModelCapabilities.Type;

const CODEX_DRIVER_KIND = ProviderDriverKind.make("codex");
const CLAUDE_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
const CURSOR_DRIVER_KIND = ProviderDriverKind.make("cursor");
const GROK_DRIVER_KIND = ProviderDriverKind.make("grok");
const OPENCODE_DRIVER_KIND = ProviderDriverKind.make("opencode");
/**
 * Driver kind for an agent the user configures rather than one this build
 * ships an implementation for. Several instances of it can be configured, each
 * pointing at a different ACP agent.
 */
export const ACP_AGENT_DRIVER_KIND = ProviderDriverKind.make("acpAgent");

/**
 * Icon identifiers a provider snapshot may advertise.
 *
 * Clients own the artwork; a snapshot only names which glyph to draw. Drivers
 * whose icon is fixed in code leave the key unset and clients fall back to
 * their own per-driver mapping. The list exists because the configurable ACP
 * agent driver has no icon of its own - the user picks one, and it has to be
 * a name both the server and every client agree on.
 *
 * Keys name a look, not a vendor endorsement: an agent that is a front end for
 * some model family should be able to look like it.
 */
export const PROVIDER_ICON_KEY_CHOICES: ReadonlyArray<{
  readonly value: string;
  readonly label: string;
}> = [
  { value: "acp", label: "ACP" },
  { value: "anchor", label: "Anchor" },
  { value: "terminal", label: "Terminal" },
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
  { value: "gemini", label: "Gemini" },
  { value: "copilot", label: "GitHub Copilot" },
  { value: "cursor", label: "Cursor" },
  { value: "grok", label: "Grok" },
  { value: "opencode", label: "OpenCode" },
  { value: "trae", label: "Trae" },
  { value: "kiro", label: "Kiro" },
  { value: "antigravity", label: "Antigravity" },
  { value: "pi", label: "Pi" },
];

/** The glyph a snapshot gets when it names an icon we do not have. */
export const DEFAULT_PROVIDER_ICON_KEY = "acp";

/** Just the keys, for validation and for the artwork tables clients keep. */
export const PROVIDER_ICON_KEYS: ReadonlyArray<string> = PROVIDER_ICON_KEY_CHOICES.map(
  (choice) => choice.value,
);

const PROVIDER_ICON_KEY_SET = new Set(PROVIDER_ICON_KEYS);

export function isProviderIconKey(value: string | null | undefined): boolean {
  return value !== null && value !== undefined && PROVIDER_ICON_KEY_SET.has(value);
}

/**
 * The icon key a driver whose agent is fixed in code always draws.
 *
 * This is contract data rather than client data: it decides what the web and
 * the mobile app show for the same provider, and the two drawing different
 * glyphs for one instance is a bug neither client can see on its own.
 */
export const PROVIDER_ICON_KEY_BY_DRIVER_KIND: Partial<Record<ProviderDriverKind, string>> = {
  [CODEX_DRIVER_KIND]: "openai",
  [CLAUDE_DRIVER_KIND]: "anthropic",
  [CURSOR_DRIVER_KIND]: "cursor",
  [GROK_DRIVER_KIND]: "grok",
  [OPENCODE_DRIVER_KIND]: "opencode",
  // The user picks the glyph for a configured agent. Until they do, the
  // protocol's own mark says "some ACP agent" without claiming a vendor.
  [ACP_AGENT_DRIVER_KIND]: DEFAULT_PROVIDER_ICON_KEY,
};

/**
 * Which glyph one provider instance draws, for every client.
 *
 * The instance's own key wins, because for a configured agent it is the only
 * answer there is. A key this build does not have still draws something: it
 * came from a newer server that does have it, and initials would be a worse
 * answer than the protocol's own mark. `undefined` means the driver has no
 * glyph, and a client that gets it must draw none rather than guess.
 */
export function resolveProviderIconKey(input: {
  readonly driverKind: ProviderDriverKind | string | null | undefined;
  readonly iconKey?: string | null | undefined;
}): string | undefined {
  const named = input.iconKey?.trim();
  if (named) {
    return isProviderIconKey(named) ? named : DEFAULT_PROVIDER_ICON_KEY;
  }
  return input.driverKind
    ? PROVIDER_ICON_KEY_BY_DRIVER_KIND[ProviderDriverKind.make(input.driverKind)]
    : undefined;
}

export const DEFAULT_MODEL = "gpt-5.6-sol";

/**
 * Codex default-model preference, most preferred first. The provider snapshot
 * marks the first of these present in the live `model/list` response as
 * default; when none are available, Codex's own `isDefault` flag wins.
 */
export const PREFERRED_DEFAULT_CODEX_MODELS: ReadonlyArray<string> = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
];
export const DEFAULT_TEXT_GENERATION_MODEL = "gpt-5.6-luna";
export const DEFAULT_TEXT_GENERATION_REASONING_EFFORT = "low";

export const DEFAULT_MODEL_BY_PROVIDER: Partial<Record<ProviderDriverKind, string>> = {
  [CODEX_DRIVER_KIND]: DEFAULT_MODEL,
  [CLAUDE_DRIVER_KIND]: "claude-sonnet-5",
  [CURSOR_DRIVER_KIND]: "auto",
  [GROK_DRIVER_KIND]: "grok-build",
  [OPENCODE_DRIVER_KIND]: "openai/gpt-5",
  // Deliberately empty. A configured ACP agent owns its own model menu, and a
  // model id invented here would be sent to it as `session/set_model` and
  // refused. An empty string reads as "no model" everywhere it is consumed.
  [ACP_AGENT_DRIVER_KIND]: "",
};

/** Per-provider text generation model defaults. */
export const DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER: Partial<
  Record<ProviderDriverKind, string>
> = {
  [CODEX_DRIVER_KIND]: DEFAULT_TEXT_GENERATION_MODEL,
  [CLAUDE_DRIVER_KIND]: "claude-haiku-4-5",
  [CURSOR_DRIVER_KIND]: "composer-2",
  [OPENCODE_DRIVER_KIND]: "openai/gpt-5",
};

export const MODEL_SLUG_ALIASES_BY_PROVIDER: Partial<
  Record<ProviderDriverKind, Record<string, string>>
> = {
  [CODEX_DRIVER_KIND]: {
    "gpt-5-codex": "gpt-5.4",
    "5.4": "gpt-5.4",
    "5.3": "gpt-5.3-codex",
    "gpt-5.3": "gpt-5.3-codex",
    "5.3-spark": "gpt-5.3-codex-spark",
    "gpt-5.3-spark": "gpt-5.3-codex-spark",
  },
  [CLAUDE_DRIVER_KIND]: {
    opus: "claude-opus-5",
    "opus-5": "claude-opus-5",
    "claude-opus-5.0": "claude-opus-5",
    "claude-opus-5-0": "claude-opus-5",
    "opus-4.8": "claude-opus-4-8",
    "claude-opus-4.8": "claude-opus-4-8",
    "opus-4.7": "claude-opus-4-7",
    "claude-opus-4.7": "claude-opus-4-7",
    "opus-4.6": "claude-opus-4-6",
    "claude-opus-4.6": "claude-opus-4-6",
    "claude-opus-4-6-20251117": "claude-opus-4-6",
    sonnet: "claude-sonnet-5",
    "sonnet-5": "claude-sonnet-5",
    "claude-sonnet-5.0": "claude-sonnet-5",
    "claude-sonnet-5-0": "claude-sonnet-5",
    "sonnet-4.6": "claude-sonnet-4-6",
    "claude-sonnet-4.6": "claude-sonnet-4-6",
    "claude-sonnet-4-6-20251117": "claude-sonnet-4-6",
    haiku: "claude-haiku-4-5",
    "haiku-4.5": "claude-haiku-4-5",
    "claude-haiku-4.5": "claude-haiku-4-5",
    "claude-haiku-4-5-20251001": "claude-haiku-4-5",
  },
  [CURSOR_DRIVER_KIND]: {
    composer: "composer-2",
    "composer-1.5": "composer-1.5",
    "composer-1": "composer-1.5",
    "opus-4.6-thinking": "claude-opus-4-6",
    "opus-4.6": "claude-opus-4-6",
    "sonnet-4.6-thinking": "claude-sonnet-4-6",
    "sonnet-4.6": "claude-sonnet-4-6",
    "opus-4.5-thinking": "claude-opus-4-5",
    "opus-4.5": "claude-opus-4-5",
  },
  [OPENCODE_DRIVER_KIND]: {},
};

// ── Provider display names ────────────────────────────────────────────

export const PROVIDER_DISPLAY_NAMES: Partial<Record<ProviderDriverKind, string>> = {
  [CODEX_DRIVER_KIND]: "Codex",
  [CLAUDE_DRIVER_KIND]: "Claude",
  [CURSOR_DRIVER_KIND]: "Cursor",
  [GROK_DRIVER_KIND]: "Grok",
  [OPENCODE_DRIVER_KIND]: "OpenCode",
  [ACP_AGENT_DRIVER_KIND]: "ACP agent",
};
