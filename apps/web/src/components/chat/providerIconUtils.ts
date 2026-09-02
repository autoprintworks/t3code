import { PROVIDER_ICON_KEYS, ProviderDriverKind, resolveProviderIconKey } from "@t3tools/contracts";
import {
  ACPRegistryIcon,
  AnchorIcon,
  AntigravityIcon,
  ClaudeAI,
  CursorIcon,
  Gemini,
  GithubCopilotIcon,
  GrokIcon,
  Icon,
  KiroIcon,
  OpenAI,
  OpenCodeIcon,
  PiAgentIcon,
  TerminalPromptIcon,
  TraeIcon,
} from "../Icons";
import { PROVIDER_OPTIONS } from "../../session-logic";

/**
 * Artwork for every icon key the contract names.
 *
 * This table is the whole of this client's icon knowledge. *Which* key an
 * instance draws is decided in `@t3tools/contracts` by `resolveProviderIconKey`
 * so that the web and the mobile app cannot answer it differently; a client
 * only turns the answer into a glyph. Every key in `PROVIDER_ICON_KEYS` must
 * appear here, and `providerIconUtils.test.ts` asserts it.
 */
export const PROVIDER_ICON_BY_ICON_KEY: Record<string, Icon> = {
  acp: ACPRegistryIcon,
  anchor: AnchorIcon,
  terminal: TerminalPromptIcon,
  anthropic: ClaudeAI,
  openai: OpenAI,
  gemini: Gemini,
  copilot: GithubCopilotIcon,
  cursor: CursorIcon,
  grok: GrokIcon,
  opencode: OpenCodeIcon,
  trae: TraeIcon,
  kiro: KiroIcon,
  antigravity: AntigravityIcon,
  pi: PiAgentIcon,
};

/** Every icon key the contract names, for a test that keeps this table honest. */
export const PROVIDER_ICON_KEYS_WITHOUT_ARTWORK = PROVIDER_ICON_KEYS.filter(
  (key) => PROVIDER_ICON_BY_ICON_KEY[key] === undefined,
);

/**
 * The glyph for one provider instance, or nothing when its driver has none.
 *
 * The choice of key belongs to the contract; this only draws it.
 */
export function providerInstanceIcon(input: {
  readonly driverKind: ProviderDriverKind | string | null | undefined;
  readonly iconKey?: string | null | undefined;
}): Icon | null {
  const key = resolveProviderIconKey(input);
  return key === undefined ? null : (PROVIDER_ICON_BY_ICON_KEY[key] ?? null);
}

function isAvailableProviderOption(option: (typeof PROVIDER_OPTIONS)[number]): option is {
  value: ProviderDriverKind;
  label: string;
  available: true;
  pickerSidebarBadge?: "new" | "soon";
} {
  return option.available;
}

export const AVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter(isAvailableProviderOption);

export type ModelEsque = {
  slug: string;
  name: string;
  shortName?: string | undefined;
  subProvider?: string | undefined;
  isLegacy?: boolean | undefined;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingQualifier(value: string, qualifier: string | null | undefined): string {
  const trimmedQualifier = qualifier?.trim();
  if (!trimmedQualifier) {
    return value;
  }

  const pattern = new RegExp(`^${escapeRegExp(trimmedQualifier)}(?:\\s*[.:/-]\\s*|\\s+)`, "iu");
  return value.replace(pattern, "").trim() || value;
}

export function getDisplayModelName(
  model: ModelEsque,
  options?: { preferShortName?: boolean },
): string {
  const name = options?.preferShortName && model.shortName ? model.shortName : model.name;
  return stripLeadingQualifier(name, model.subProvider);
}

export function getTriggerDisplayModelName(model: ModelEsque): string {
  return getDisplayModelName(model, { preferShortName: true });
}

export function getTriggerDisplayModelLabel(model: ModelEsque): string {
  return getTriggerDisplayModelName(model);
}
