import { DEFAULT_PROVIDER_ICON_KEY, ProviderDriverKind } from "@t3tools/contracts";
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

export const PROVIDER_ICON_BY_PROVIDER: Partial<Record<ProviderDriverKind, Icon>> = {
  [ProviderDriverKind.make("codex")]: OpenAI,
  [ProviderDriverKind.make("claudeAgent")]: ClaudeAI,
  [ProviderDriverKind.make("opencode")]: OpenCodeIcon,
  [ProviderDriverKind.make("cursor")]: CursorIcon,
  [ProviderDriverKind.make("grok")]: GrokIcon,
};

/**
 * Artwork for the icon key a provider snapshot may name.
 *
 * A driver whose icon is fixed in code names none of these and falls back to
 * `PROVIDER_ICON_BY_PROVIDER`. The configurable ACP agent driver has no icon
 * of its own, so its user picks one by key from
 * `PROVIDER_ICON_KEY_CHOICES` and this is where that key becomes a glyph.
 * Every key in that list must appear here.
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

/**
 * The glyph for one provider instance: the icon its snapshot asked for, the
 * one its driver always uses, or nothing. A snapshot that names an icon this
 * build does not have still gets a glyph rather than initials, because the key
 * came from a newer server that does have it.
 */
export function providerInstanceIcon(input: {
  readonly driverKind: ProviderDriverKind;
  readonly iconKey?: string | undefined;
}): Icon | null {
  const key = input.iconKey?.trim();
  if (key) {
    return PROVIDER_ICON_BY_ICON_KEY[key] ?? PROVIDER_ICON_BY_ICON_KEY[DEFAULT_PROVIDER_ICON_KEY]!;
  }
  return PROVIDER_ICON_BY_PROVIDER[input.driverKind] ?? null;
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
