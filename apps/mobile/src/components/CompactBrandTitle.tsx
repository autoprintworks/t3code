import Constants from "expo-constants";
import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { Platform, View } from "react-native";
import { resolveForkBuildIdentity } from "@t3tools/shared/forkBuild";

import { AppText as Text } from "./AppText";
import { T3Wordmark } from "./T3Wordmark";
import { IPAD_HOME_TITLE_OFFSET } from "../lib/layoutMetrics";
import { resolveMobileStageLabel } from "../lib/mobileBranding";

// Every build from this repository is the fork (#59), so the tag is not conditional.
const FORK_TAG_LABEL = resolveForkBuildIdentity().tagLabel;

/**
 * Horizontal correction applied to content rendered in the brand title slot,
 * shared with the connection-status swap so both align identically.
 */
export function brandTitleOffset(): number {
  if (Platform.OS !== "ios") return 0;
  return Platform.isPad ? IPAD_HOME_TITLE_OFFSET : 0;
}

/**
 * Compact brand lockup sized for native navigation bars.
 */
export function CompactBrandTitle(
  props: {
    readonly allowFontScaling?: boolean;
  } = {},
) {
  const stageLabel = resolveMobileStageLabel(Constants.expoConfig?.extra?.appVariant);
  const titleOffset = brandTitleOffset();

  return (
    <View
      aria-level={1}
      accessibilityLabel={`T3 Code ${FORK_TAG_LABEL}, Threads`}
      accessible
      role="heading"
      className="flex-row items-center gap-1.5"
      style={{ marginLeft: titleOffset }}
    >
      <T3Wordmark colorClassName="accent-icon" height={15} />
      <Text
        allowFontScaling={props.allowFontScaling}
        className="font-t3-medium text-[21px] tracking-[-0.5px] text-foreground-muted"
      >
        Code
      </Text>
      <BrandPill allowFontScaling={props.allowFontScaling} label={FORK_TAG_LABEL} />
      <BrandPill allowFontScaling={props.allowFontScaling} label={stageLabel} />
    </View>
  );
}

function BrandPill(props: { readonly allowFontScaling?: boolean; readonly label: string }) {
  return (
    <View className="rounded-full bg-subtle px-1.5 py-0.5">
      <Text
        allowFontScaling={props.allowFontScaling}
        className="font-t3-bold text-[9px] tracking-[0.9px] text-foreground-muted uppercase"
      >
        {props.label}
      </Text>
    </View>
  );
}

export function renderCompactBrandTitle() {
  return <CompactBrandTitle allowFontScaling={Platform.OS === "ios"} />;
}

export function getCompactBrandHeaderOptions(
  fallbackTitleStyle?: NativeStackNavigationOptions["headerTitleStyle"],
): NativeStackNavigationOptions {
  return {
    headerTitle: renderCompactBrandTitle,
    headerTitleStyle: fallbackTitleStyle,
    title: "Threads",
    unstable_headerLeftItems: undefined,
  };
}
