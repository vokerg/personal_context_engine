import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  ApiRequestError,
  describeNotesError,
  getNotes,
  type NotePreview,
} from "@pce/api-client";
import { describeListState, type RemoteState } from "./screen-state";
import type { MobileSession } from "./session";
import type { Appearance, Palette } from "./theme";
import { ActionButton, Panel, SectionTitle, StatusMessage } from "./ui";

async function authorizedRead<T>(
  session: MobileSession,
  request: () => Promise<T>,
): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (!(error instanceof ApiRequestError) || error.status !== 401)
      throw error;
    const access = await session.forceRefresh();
    if (!access) throw error;
    return request();
  }
}

function friendly(error: unknown, detail = false): string {
  return error instanceof ApiRequestError && error.status === 401
    ? "Session expired. Sign in again."
    : describeNotesError(error, detail);
}

function ReadState({
  state,
  retry,
  palette,
}: {
  state: ReturnType<typeof describeListState>;
  retry: () => void;
  palette: Palette;
}) {
  if (state.state === "content") return null;
  return (
    <StatusMessage
      palette={palette}
      heading={state.heading}
      description={state.description}
      alert={state.alert}
      retry={state.canRetry ? retry : undefined}
    />
  );
}

/** Read-only v1 shell screen. #124 supplies search/facets/pagination. */
export function NotesScreen({
  session,
  palette,
  onOpenNote,
}: {
  session: MobileSession;
  palette: Palette;
  onOpenNote: (id: string) => void;
}) {
  const [notes, setNotes] = useState<NotePreview[]>([]);
  const [status, setStatus] = useState<RemoteState>("loading");
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let mounted = true;
    const controller = new AbortController();
    setNotes([]);
    setStatus("loading");
    setError("");
    const options = {
      baseUrl: session.config.apiOrigin,
      getAccessToken: () => session.getAccessToken(),
      signal: controller.signal,
      timeoutMs: 12000,
    };
    void authorizedRead(session, () => getNotes(options)).then(
      (result) => {
        if (!mounted) return;
        setNotes(result.notes);
        setStatus("ready");
      },
      (reason: unknown) => {
        if (!mounted) return;
        setStatus("error");
        setError(friendly(reason));
      },
    );
    return () => {
      mounted = false;
      controller.abort();
    };
  }, [session, revision]);

  const presentation = describeListState(status, notes.length, error);
  return (
    <View style={{ gap: 14 }}>
      <SectionTitle palette={palette}>Notes</SectionTitle>
      <ActionButton
        label="Refresh notes"
        palette={palette}
        secondary
        onPress={() => setRevision((value) => value + 1)}
      />
      <ReadState
        state={presentation}
        palette={palette}
        retry={() => setRevision((value) => value + 1)}
      />
      {presentation.state === "content"
        ? notes.map((note) => (
            <Pressable
              key={note.id}
              accessibilityRole="button"
              accessibilityLabel={"Open note: " + note.title}
              onPress={() => onOpenNote(note.id)}
              style={({ pressed }) => ({
                padding: 16,
                borderWidth: 1,
                borderRadius: 16,
                gap: 6,
                borderColor: palette.border,
                backgroundColor: palette.surface,
                opacity: pressed ? 0.8 : 1,
              })}
            >
              <Text
                style={{ color: palette.text, fontWeight: "600", fontSize: 17 }}
              >
                {note.title}
              </Text>
              <Text style={{ color: palette.secondary, fontSize: 15 }}>
                {note.summary}
              </Text>
            </Pressable>
          ))
        : null}
    </View>
  );
}

export function UpcomingScreen({
  name,
  explanation,
  palette,
}: {
  name: "Search" | "Capture";
  explanation: string;
  palette: Palette;
}) {
  return (
    <View style={{ gap: 14 }}>
      <SectionTitle palette={palette}>{name}</SectionTitle>
      <StatusMessage
        palette={palette}
        heading={name + " is not available yet"}
        description={explanation}
      />
    </View>
  );
}

export function SettingsScreen({
  appearance,
  onAppearance,
  palette,
  onSignOut,
}: {
  appearance: Appearance;
  onAppearance: (value: Appearance) => void;
  palette: Palette;
  onSignOut: () => void;
}) {
  const choices: readonly Appearance[] = ["system", "light", "dark"];
  return (
    <View style={{ gap: 14 }}>
      <SectionTitle palette={palette}>Settings</SectionTitle>
      <Panel palette={palette}>
        <Text
          accessibilityRole="header"
          style={{ color: palette.text, fontSize: 18, fontWeight: "600" }}
        >
          Appearance
        </Text>
        <Text style={{ color: palette.secondary }}>
          Choose system, light or dark. This preference lasts for this app
          session.
        </Text>
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          {choices.map((choice) => (
            <Pressable
              key={choice}
              accessibilityRole="button"
              accessibilityLabel={choice + " appearance"}
              accessibilityState={{ selected: appearance === choice }}
              onPress={() => onAppearance(choice)}
              style={{
                backgroundColor:
                  appearance === choice ? palette.primary : palette.subtle,
                borderColor: palette.border,
                borderWidth: 1,
                borderRadius: 10,
                paddingHorizontal: 18,
                paddingVertical: 12,
                minHeight: 44,
              }}
            >
              <Text
                style={{
                  color:
                    appearance === choice ? palette.onPrimary : palette.text,
                  fontWeight: "600",
                  textTransform: "capitalize",
                }}
              >
                {choice}
              </Text>
            </Pressable>
          ))}
        </View>
      </Panel>
      <ActionButton
        label="Sign out"
        palette={palette}
        secondary
        onPress={onSignOut}
      />
    </View>
  );
}
