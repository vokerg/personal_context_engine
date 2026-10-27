import { useEffect, useState } from "react";
import {
  AccessibilityInfo,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  GlassView,
  isGlassEffectAPIAvailable,
  isLiquidGlassAvailable,
} from "expo-glass-effect";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { MOBILE_TABS, type MobileTab } from "./navigation";
import type { Palette } from "./theme";

const items: Record<
  MobileTab,
  {
    label: string;
    icon: SymbolViewProps["name"];
    selected: SymbolViewProps["name"];
  }
> = {
  tasks: {
    label: "Tasks",
    icon: "checkmark.circle",
    selected: "checkmark.circle.fill",
  },
  notes: { label: "Notes", icon: "doc.text", selected: "doc.text.fill" },
  search: {
    label: "Search",
    icon: "magnifyingglass",
    selected: "magnifyingglass",
  },
  capture: {
    label: "Capture",
    icon: "plus.circle",
    selected: "plus.circle.fill",
  },
  settings: {
    label: "Settings",
    icon: "gearshape",
    selected: "gearshape.fill",
  },
};

export function TabBar({
  active,
  palette,
  onSelect,
  onHeight,
  tasksEnabled = false,
}: {
  active: MobileTab;
  tasksEnabled?: boolean;
  palette: Palette;
  onSelect: (tab: MobileTab) => void;
  onHeight: (height: number) => void;
}) {
  // Start opaque until the accessibility preference is known; follow live changes.
  const [reduceTransparency, setReduceTransparency] = useState(true);
  useEffect(() => {
    let mounted = true;
    let receivedChange = false;
    const subscription = AccessibilityInfo.addEventListener(
      "reduceTransparencyChanged",
      (enabled) => {
        receivedChange = true;
        setReduceTransparency(enabled);
      },
    );
    void AccessibilityInfo.isReduceTransparencyEnabled()
      .then((enabled) => {
        if (mounted && !receivedChange) setReduceTransparency(enabled);
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);
  const glass =
    Platform.OS === "ios" &&
    !reduceTransparency &&
    isLiquidGlassAvailable() &&
    isGlassEffectAPIAvailable();

  const Surface = glass ? GlassView : View;
  return (
    <View
      accessibilityRole="tablist"
      onLayout={(event) => onHeight(event.nativeEvent.layout.height)}
      style={styles.position}
    >
      <Surface
        key={glass ? (palette.dark ? "glass-dark" : "glass-light") : "opaque"}
        {...(glass
          ? {
              glassEffectStyle: "regular" as const,
              colorScheme: palette.dark
                ? ("dark" as const)
                : ("light" as const),
            }
          : {})}
        style={[
          styles.bar,
          {
            backgroundColor: glass ? "transparent" : palette.surface,
            borderColor: glass ? "transparent" : palette.border,
          },
        ]}
      >
        {(tasksEnabled
          ? (["notes", "tasks", "search", "capture", "settings"] as const)
          : MOBILE_TABS
        ).map((tab) => {
          const selected = active === tab;
          const item = items[tab];
          const color = selected ? palette.primary : palette.secondary;
          return (
            <Pressable
              key={tab}
              accessibilityRole="tab"
              accessibilityLabel={item.label}
              accessibilityState={{ selected }}
              onPress={() => onSelect(tab)}
              style={({ pressed }) => [
                styles.tab,
                {
                  backgroundColor:
                    selected || pressed
                      ? glass
                        ? palette.dark
                          ? "rgba(255,255,255,0.12)"
                          : "rgba(23,79,137,0.09)"
                        : palette.subtle
                      : "transparent",
                },
              ]}
            >
              <SymbolView
                name={selected ? item.selected : item.icon}
                tintColor={color}
                size={23}
                weight={selected ? "semibold" : "regular"}
                style={styles.icon}
                accessible={false}
              />
              <Text
                style={{
                  color,
                  fontSize: 12,
                  fontWeight: selected ? "700" : "500",
                }}
              >
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </Surface>
    </View>
  );
}

const styles = StyleSheet.create({
  position: {
    position: "absolute",
    bottom: 12,
    left: 16,
    right: 16,
  },
  bar: {
    borderRadius: 32,
    borderWidth: 1,
    padding: 6,
    flexDirection: "row",
    gap: 4,
  },
  tab: {
    flex: 1,
    minWidth: 0,
    minHeight: 56,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 26,
    paddingVertical: 7,
    paddingHorizontal: 3,
    gap: 3,
  },
  icon: { width: 25, height: 25 },
});
