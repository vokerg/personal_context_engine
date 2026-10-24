import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { Palette } from "./theme";

export function ActionButton({
  label,
  onPress,
  palette,
  secondary = false,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  palette: Palette;
  secondary?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: secondary ? palette.subtle : palette.primary,
        borderColor: secondary ? palette.border : palette.primary,
        borderWidth: 1,
        borderRadius: 12,
        paddingVertical: 12,
        paddingHorizontal: 16,
        minHeight: 46,
        opacity: pressed || disabled ? 0.75 : 1,
        justifyContent: "center",
      })}
    >
      <Text
        style={{
          color: secondary ? palette.text : palette.onPrimary,
          fontWeight: "600",
          textAlign: "center",
          fontSize: 16,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function Panel({
  children,
  palette,
}: {
  children: ReactNode;
  palette: Palette;
}) {
  return (
    <View
      style={{
        backgroundColor: palette.surface,
        borderColor: palette.border,
        borderWidth: 1,
        borderRadius: 16,
        padding: 18,
        gap: 12,
      }}
    >
      {children}
    </View>
  );
}

export function StatusMessage({
  palette,
  heading,
  description,
  alert = false,
  retry,
}: {
  palette: Palette;
  heading: string;
  description?: string;
  alert?: boolean;
  retry?: () => void;
}) {
  return (
    <Panel palette={palette}>
      <View accessibilityRole={alert ? "alert" : "summary"} style={{ gap: 5 }}>
        <Text style={{ color: palette.text, fontSize: 18, fontWeight: "600" }}>
          {heading}
        </Text>
        {description ? (
          <Text style={{ color: palette.secondary, fontSize: 15 }}>
            {description}
          </Text>
        ) : null}
      </View>
      {retry ? (
        <ActionButton
          label="Retry"
          onPress={retry}
          palette={palette}
          secondary
        />
      ) : null}
    </Panel>
  );
}

export function SectionTitle({
  children,
  palette,
}: {
  children: ReactNode;
  palette: Palette;
}) {
  return (
    <Text
      accessibilityRole="header"
      style={{ color: palette.text, fontSize: 25, fontWeight: "700" }}
    >
      {children}
    </Text>
  );
}
