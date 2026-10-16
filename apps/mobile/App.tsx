import { useEffect, useState } from "react";
import {
  Linking,
  SafeAreaView,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import {
  ApiRequestError,
  describeNotesError,
  getNote,
  getNotes,
  type NoteDetail,
  type NotePreview,
} from "@pce/api-client";
import { parseNoteDeepLink } from "./links";

const apiBaseUrl = process.env.EXPO_PUBLIC_API_BASE_URL;
type LoadState = "loading" | "ready" | "error";

function Action({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      onPress={onPress}
      style={{ backgroundColor: "#234f85", padding: 12, marginVertical: 6, borderRadius: 6 }}
    >
      <Text style={{ color: "white", fontWeight: "600" }}>{label}</Text>
    </TouchableOpacity>
  );
}

/** Token and note bodies are intentionally memory-only; no credentials in Expo config. */
export default function App() {
  const [draft, setDraft] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [notes, setNotes] = useState<NotePreview[]>([]);
  const [listState, setListState] = useState<LoadState>("loading");
  const [listError, setListError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<NoteDetail | null>(null);
  const [detailState, setDetailState] = useState<LoadState>("loading");
  const [detailError, setDetailError] = useState("");

  function clearSession(message = "") {
    setToken(null);
    setDraft("");
    setNotice(message);
    setNotes([]);
    setSelectedId(null);
    setDetail(null);
  }

  useEffect(() => {
    let active = true;
    const onUrl = (value: string | null) => {
      if (!active || !value) return;
      const id = parseNoteDeepLink(value);
      if (id) setSelectedId(id);
    };
    void Linking.getInitialURL().then(onUrl).catch(() => undefined);
    const subscription = Linking.addEventListener("url", ({ url }) => onUrl(url));
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (!token || !apiBaseUrl) return;
    let active = true;
    const controller = new AbortController();
    setListState("loading");
    setListError("");
    getNotes({
      baseUrl: apiBaseUrl,
      getAccessToken: () => token,
      signal: controller.signal,
      timeoutMs: 12000,
    })
      .then((result) => {
        if (!active) return;
        setNotes(result.notes);
        setListState("ready");
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof ApiRequestError && error.status === 401) {
          clearSession(describeNotesError(error));
        } else {
          setListState("error");
          setListError(describeNotesError(error));
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [token]);

  useEffect(() => {
    if (!token || !selectedId || !apiBaseUrl) return;
    let active = true;
    const controller = new AbortController();
    setDetail(null);
    setDetailState("loading");
    getNote(
      {
        baseUrl: apiBaseUrl,
        getAccessToken: () => token,
        signal: controller.signal,
        timeoutMs: 12000,
      },
      selectedId,
    )
      .then((result) => {
        if (!active) return;
        setDetail(result);
        setDetailState("ready");
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof ApiRequestError && error.status === 401) {
          clearSession(describeNotesError(error));
        } else {
          setDetailState("error");
          setDetailError(describeNotesError(error, true));
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [token, selectedId]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#f7f9fc" }}>
      <ScrollView contentContainerStyle={{ padding: 22, gap: 10 }}>
        <Text style={{ fontSize: 25, fontWeight: "700", color: "#19334e" }}>
          Personal Context Engine
        </Text>
        <Text>Read-only preview. No login, note editing, push delivery or notifications.</Text>
        {!apiBaseUrl ? (
          <Text accessibilityRole="alert">
            Set EXPO_PUBLIC_API_BASE_URL to a device-reachable HTTPS API URL
            before starting Expo (loopback HTTP is for local development only).
          </Text>
        ) : !token ? (
          <View>
            <Text style={{ fontSize: 19, fontWeight: "600" }}>Sign-in required</Text>
            {notice ? <Text accessibilityRole="alert">{notice}</Text> : null}
            <Text>
              Development only: paste a short-lived notes:read JWT from a
              trusted issuer. It is held in memory until the session is cleared.
            </Text>
            {selectedId ? (
              <Text>A note link is pending authentication.</Text>
            ) : null}
            <TextInput
              accessibilityLabel="Development access token"
              placeholder="Development access token"
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              value={draft}
              onChangeText={setDraft}
              style={{ borderWidth: 1, borderColor: "#8593a3", padding: 10, marginTop: 10 }}
            />
            {draft.trim() ? (
              <Action
                label="Connect"
                onPress={() => {
                  setToken(draft.trim());
                  setDraft("");
                  setNotice("");
                }}
              />
            ) : null}
          </View>
        ) : (
          <View>
            <Action label="Clear session" onPress={() => clearSession()} />
            <Text style={{ fontSize: 19, fontWeight: "600" }}>Notes</Text>
            {listState === "loading" ? <Text>Loading notes…</Text> : null}
            {listState === "error" ? (
              <Text accessibilityRole="alert">{listError}</Text>
            ) : null}
            {listState === "ready" && notes.length === 0 ? (
              <Text>No notes available for this session.</Text>
            ) : null}
            {listState === "ready"
              ? notes.map((note) => (
                  <View key={note.id}>
                    <Action
                      label={note.title}
                      onPress={() => setSelectedId(note.id)}
                    />
                    <Text>{note.summary}</Text>
                  </View>
                ))
              : null}
            {selectedId ? (
              <View style={{ marginTop: 16 }}>
                <Text style={{ fontSize: 19, fontWeight: "600" }}>Note detail</Text>
                {detailState === "loading" ? <Text>Loading detail…</Text> : null}
                {detailState === "error" ? (
                  <Text accessibilityRole="alert">{detailError}</Text>
                ) : null}
                {detailState === "ready" && detail ? (
                  <View>
                    <Text style={{ fontWeight: "700" }}>{detail.title}</Text>
                    <Text>{detail.summary}</Text>
                    <Text>{detail.body}</Text>
                  </View>
                ) : null}
              </View>
            ) : null}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
