import { useEffect, useMemo, useState } from "react";
import {
  AppState, Linking, SafeAreaView, ScrollView, Text, TouchableOpacity, View,
} from "react-native";
import {
  ApiRequestError, describeNotesError, getNote, getNotes,
  type NoteDetail, type NotePreview,
} from "@pce/api-client";
import { parseNoteDeepLink } from "./links";
import { createNativeSession } from "./native-auth";
import type { MobileSession, SessionView } from "./session";

type LoadState = "loading" | "ready" | "error";
function Action({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <TouchableOpacity accessibilityRole="button" accessibilityLabel={label}
      onPress={onPress} style={{
        backgroundColor: "#234f85", padding: 12, marginVertical: 6, borderRadius: 6,
      }}>
      <Text style={{ color: "white", fontWeight: "600" }}>{label}</Text>
    </TouchableOpacity>
  );
}
async function authorizedRead<T>(
  session: MobileSession,
  request: () => Promise<T>,
): Promise<T> {
  try { return await request(); }
  catch (error) {
    if (!(error instanceof ApiRequestError) || error.status !== 401) throw error;
    const token = await session.forceRefresh();
    if (!token) throw error;
    return request();
  }
}
const friendly = (error: unknown, detail = false) =>
  error instanceof ApiRequestError && error.status === 401
    ? "Session expired. Sign in again."
    : describeNotesError(error, detail);

/** Token entry is deliberately absent. Authorization uses iOS system browser. */
export default function App() {
  const session = useMemo(() => createNativeSession(), []);
  const [auth, setAuth] = useState<SessionView>(
    session?.snapshot ?? { phase: "signed-out", notice: "", revision: 0 },
  );
  const [notes, setNotes] = useState<NotePreview[]>([]);
  const [listState, setListState] = useState<LoadState>("loading");
  const [listError, setListError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<NoteDetail | null>(null);
  const [detailState, setDetailState] = useState<LoadState>("loading");
  const [detailError, setDetailError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!session) return;
    const unsubscribe = session.subscribe(setAuth);
    void session.restore();
    return unsubscribe;
  }, [session]);

  // Recheck the short-lived grant when returning from the background.
  useEffect(() => {
    if (!session) return;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && session.snapshot.phase === "signed-in")
        void session.getAccessToken();
    });
    return () => subscription.remove();
  }, [session]);

  useEffect(() => {
    let active = true;
    const onUrl = (value: string | null) => {
      if (!active || !value) return;
      const id = parseNoteDeepLink(value);
      if (id) setSelectedId(id);
    };
    void Linking.getInitialURL().then(onUrl).catch(() => undefined);
    const subscription = Linking.addEventListener("url", ({ url }) => onUrl(url));
    return () => { active = false; subscription.remove(); };
  }, []);

  useEffect(() => {
    if (auth.phase === "signed-in") return;
    setNotes([]);
    setDetail(null);
    setListState("loading");
    setDetailState("loading");
  }, [auth.phase]);

  useEffect(() => {
    if (auth.phase !== "signed-in" || !session) return;
    let active = true;
    const controller = new AbortController();
    setListState("loading");
    setListError("");
    const options = {
      baseUrl: session.config.apiOrigin,
      getAccessToken: () => session.getAccessToken(),
      signal: controller.signal,
      timeoutMs: 12000,
    };
    void authorizedRead(session, () => getNotes(options)).then(
      (result) => { if (active) { setNotes(result.notes); setListState("ready"); } },
      (error: unknown) => {
        if (!active) return;
        setListState("error");
        setListError(friendly(error));
      },
    );
    return () => { active = false; controller.abort(); };
  }, [auth.phase, session, reload]);

  useEffect(() => {
    if (auth.phase !== "signed-in" || !selectedId || !session) return;
    let active = true;
    const controller = new AbortController();
    setDetail(null);
    setDetailState("loading");
    setDetailError("");
    const options = {
      baseUrl: session.config.apiOrigin,
      getAccessToken: () => session.getAccessToken(),
      signal: controller.signal,
      timeoutMs: 12000,
    };
    void authorizedRead(session, () => getNote(options, selectedId)).then(
      (result) => { if (active) { setDetail(result); setDetailState("ready"); } },
      (error: unknown) => {
        if (!active) return;
        setDetailState("error");
        setDetailError(friendly(error, true));
      },
    );
    return () => { active = false; controller.abort(); };
  }, [auth.phase, selectedId, session, reload]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#f7f9fc" }}>
      <ScrollView contentContainerStyle={{ padding: 22, gap: 10 }}>
        <Text style={{ fontSize: 25, fontWeight: "700", color: "#19334e" }}>
          Personal Context Engine
        </Text>
        {!session ? (
          <Text accessibilityRole="alert">
            Set EXPO_PUBLIC_API_BASE_URL to the canonical HTTPS API origin and
            EXPO_PUBLIC_OAUTH_CLIENT_ID to the registered iOS public client ID.
            Use an iOS development build; Expo Go cannot receive the private callback.
          </Text>
        ) : auth.phase === "restoring" ? (
          <Text accessibilityRole="alert">Restoring secure session…</Text>
        ) : auth.phase !== "signed-in" ? (
          <View>
            <Text style={{ fontSize: 19, fontWeight: "600" }}>Sign-in required</Text>
            <Text>
              Sign in through the system browser using your existing PCE account.
              No access token needs to be pasted into the app.
            </Text>
            {auth.notice ? <Text accessibilityRole="alert">{auth.notice}</Text> : null}
            {selectedId ? <Text>A note link is pending authentication.</Text> : null}
            <Action label="Sign in" onPress={() => { void session.signIn(); }} />
            <Action label="Retry saved session" onPress={() => { void session.restore(); }} />
          </View>
        ) : (
          <View>
            <Action label="Sign out" onPress={() => {
              setNotes([]);
              setDetail(null);
              void session.signOut();
            }} />
            {auth.notice ? <Text accessibilityRole="alert">{auth.notice}</Text> : null}
            <Text style={{ fontSize: 19, fontWeight: "600" }}>Notes</Text>
            <Action label="Refresh notes" onPress={() => setReload((value) => value + 1)} />
            {listState === "loading" ? <Text>Loading notes…</Text> : null}
            {listState === "error" ? <Text accessibilityRole="alert">{listError}</Text> : null}
            {listState === "ready" && notes.length === 0
              ? <Text>No notes available for this session.</Text> : null}
            {listState === "ready" ? notes.map((note) => (
              <View key={note.id}>
                <Action label={note.title} onPress={() => setSelectedId(note.id)} />
                <Text>{note.summary}</Text>
              </View>
            )) : null}
            {selectedId ? (
              <View style={{ marginTop: 16 }}>
                <Action label="Back to notes" onPress={() => setSelectedId(null)} />
                <Text style={{ fontSize: 19, fontWeight: "600" }}>Note detail</Text>
                {detailState === "loading" ? <Text>Loading detail…</Text> : null}
                {detailState === "error"
                  ? <Text accessibilityRole="alert">{detailError}</Text> : null}
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
