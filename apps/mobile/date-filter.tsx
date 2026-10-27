import { useState } from "react";
import { Platform, Text, View } from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { localCalendarDate } from "@pce/api-client";
import { ActionButton } from "./ui";
import type { Palette } from "./theme";
export function DateFilter({
  label,
  value,
  onChange,
  palette,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  palette: Palette;
}) {
  const [draft, setDraft] = useState<Date | null>(null);
  const open = () => {
    const parts = value.split("-").map(Number);
    setDraft(
      value ? new Date(parts[0]!, parts[1]! - 1, parts[2]!, 12) : new Date(),
    );
  };
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: palette.secondary }}>{label}</Text>
      <ActionButton
        label={label + ": " + (value || "Any date")}
        onPress={open}
        palette={palette}
        secondary
      />
      {value ? (
        <ActionButton
          label={"Clear " + label.toLowerCase()}
          onPress={() => {
            setDraft(null);
            onChange("");
          }}
          palette={palette}
          secondary
        />
      ) : null}
      {draft ? (
        <View style={{ gap: 8 }}>
          <DateTimePicker
            accessibilityLabel={label + " picker"}
            value={draft}
            mode="date"
            display={Platform.OS === "ios" ? "inline" : "default"}
            themeVariant={palette.dark ? "dark" : "light"}
            onChange={(event, date) => {
              if (event.type === "dismissed") {
                setDraft(null);
                return;
              }
              if (date) {
                if (Platform.OS === "android") {
                  onChange(localCalendarDate(date));
                  setDraft(null);
                } else setDraft(date);
              }
            }}
          />
          {Platform.OS !== "android" ? (
            <ActionButton
              label={"Apply " + label.toLowerCase()}
              onPress={() => {
                onChange(localCalendarDate(draft));
                setDraft(null);
              }}
              palette={palette}
            />
          ) : null}
          <ActionButton
            label={"Cancel " + label.toLowerCase()}
            onPress={() => setDraft(null)}
            palette={palette}
            secondary
          />
        </View>
      ) : null}
    </View>
  );
}
