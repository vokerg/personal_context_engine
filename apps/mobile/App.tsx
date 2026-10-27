import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { TasksScreen } from "./task-screen";
import { TASKS_ENABLED } from "./task-feature";
import { useEffect, useMemo, useReducer, useState } from "react";
import {
  AppState,
  BackHandler,
  KeyboardAvoidingView,
  Linking,
  PanResponder,
  Appearance as NativeAppearance,
  ScrollView,
  StatusBar,
  Text,
  useColorScheme,
  View,
} from "react-native";
import { initialNavigation, reduceNavigation } from "./navigation";
import { createNativeSession } from "./native-auth";
import { SettingsScreen, UpcomingScreen } from "./screens";
import { NoteDetailScreen } from "./detail-screen";
import type { SessionView } from "./session";
import { SearchScreen, TimelineScreen } from "./feed-screens";
import { paletteFor, type Appearance } from "./theme";
import { ActionButton, StatusMessage } from "./ui";
import { claimsBackSwipe, completesBackSwipe } from "./back-gesture";
import { NativeTabs } from "./tab-bar";

/**
 * Expo SDK54 / iOS shell. A small typed reducer drives the tab + detail stack;
 * later feature PRs replace individual screens, not the auth/deep-link boundary.
 */
export default function App() {
  const session = useMemo(() => createNativeSession(), []);
  const [auth, setAuth] = useState<SessionView>(
    session?.snapshot ?? { phase: "signed-out", notice: "", revision: 0 },
  );
  const [navigation, dispatch] = useReducer(
    reduceNavigation,
    initialNavigation,
  );
  const backGesture = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_event, gesture) =>
          claimsBackSwipe(gesture),
        onPanResponderRelease: (_event, gesture) => {
          if (completesBackSwipe(gesture)) dispatch({ type: "back" });
        },
        onPanResponderTerminationRequest: () => false,
      }),
    [],
  );
  const [appearance, setAppearance] = useState<Appearance>("system");
  const systemAppearance = useColorScheme();
  const palette = paletteFor(appearance, systemAppearance);
  useEffect(() => {
    NativeAppearance.setColorScheme(
      appearance === "system" ? null : appearance,
    );
  }, [appearance]);

  useEffect(() => {
    if (!session) return;
    const unsubscribe = session.subscribe(setAuth);
    void session.restore();
    return unsubscribe;
  }, [session]);

  useEffect(() => {
    dispatch({ type: "session", phase: auth.phase });
  }, [auth.phase]);

  useEffect(() => {
    if (!session) return;
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active" && session.snapshot.phase === "signed-in") {
        void session.getAccessToken();
      }
    });
    return () => subscription.remove();
  }, [session]);

  useEffect(() => {
    let mounted = true;
    const onUrl = (url: string | null) => {
      if (mounted && url) dispatch({ type: "link", url });
    };
    void Linking.getInitialURL()
      .then(onUrl)
      .catch(() => undefined);
    const listener = Linking.addEventListener("url", ({ url }) => onUrl(url));
    return () => {
      mounted = false;
      listener.remove();
    };
  }, []);

  // iOS supports the edge gesture and visible Back button. Keep Android scaffold's hardware
  // back semantics safe without treating Android as an App v1 target.
  useEffect(() => {
    if (!navigation.noteId || navigation.phase !== "signed-in") return;
    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      () => {
        dispatch({ type: "back" });
        return true;
      },
    );
    return () => subscription.remove();
  }, [navigation.noteId, navigation.phase]);

  const signedIn =
    Boolean(session) &&
    auth.phase === "signed-in" &&
    navigation.phase === "signed-in";
  const signOut = () => {
    // Hide private routes immediately, even before network revocation finishes.
    dispatch({ type: "reset" });
    void session?.signOut();
  };

  return (
    <SafeAreaProvider>
      <SafeAreaView
        edges={
          signedIn
            ? ["top", "left", "right"]
            : ["top", "bottom", "left", "right"]
        }
        style={{ flex: 1, backgroundColor: palette.background }}
      >
        <StatusBar
          barStyle={palette.dark ? "light-content" : "dark-content"}
          backgroundColor={palette.background}
        />
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={signedIn ? undefined : "padding"}
        >
          <View
            style={{
              flex: 1,
              width: "100%",
              alignSelf: "center",
            }}
          >
            <View
              style={{
                paddingHorizontal: 20,
                paddingVertical: 14,
                borderBottomWidth: 1,
                borderBottomColor: palette.border,
              }}
            >
              <Text
                accessibilityRole="header"
                style={{
                  color: palette.text,
                  fontSize: 22,
                  fontWeight: "700",
                }}
              >
                Personal Context Engine
              </Text>
            </View>
            <View style={{ flex: 1, minHeight: 0 }}>
              {!signedIn || !session ? (
                <ScrollView
                  keyboardShouldPersistTaps="handled"
                  contentContainerStyle={{ padding: 20, gap: 14, flexGrow: 1 }}
                >
                  {!session ? (
                    <StatusMessage
                      palette={palette}
                      heading="Native sign-in needs configuration"
                      description="Configure the HTTPS API origin and registered iOS public OAuth client. An iOS development build is needed; Expo Go cannot receive the private callback."
                      alert
                    />
                  ) : auth.phase === "restoring" ? (
                    <StatusMessage
                      palette={palette}
                      heading="Restoring secure session…"
                    />
                  ) : auth.phase !== "signed-in" ? (
                    <View style={{ gap: 16 }}>
                      <StatusMessage
                        palette={palette}
                        heading="Sign-in required"
                        description="Use the system browser and your existing PCE account. No developer token is needed."
                      />
                      {navigation.pendingNoteId ? (
                        <Text style={{ color: palette.secondary }}>
                          A note link is waiting for authentication.
                        </Text>
                      ) : null}
                      {auth.notice ? (
                        <Text
                          accessibilityRole="alert"
                          style={{ color: palette.danger }}
                        >
                          {auth.notice}
                        </Text>
                      ) : null}
                      <ActionButton
                        label="Sign in"
                        palette={palette}
                        onPress={() => void session.signIn()}
                      />
                      <ActionButton
                        label="Retry saved session"
                        palette={palette}
                        secondary
                        onPress={() => void session.restore()}
                      />
                    </View>
                  ) : (
                    <StatusMessage
                      palette={palette}
                      heading="Ending session…"
                    />
                  )}
                </ScrollView>
              ) : (
                <>
                  {auth.notice ? (
                    <Text
                      accessibilityRole="alert"
                      style={{ color: palette.danger, paddingHorizontal: 20 }}
                    >
                      {auth.notice}
                    </Text>
                  ) : null}
                  <NativeTabs
                    active={navigation.tab}
                    palette={palette}
                    tasksEnabled={TASKS_ENABLED}
                    hidden={Boolean(navigation.noteId)}
                    onSelect={(tab) => dispatch({ type: "tab", tab })}
                    renderScene={(tab, bottomInset) => {
                      const hidden =
                        Boolean(navigation.noteId) || navigation.tab !== tab;
                      if (tab === "notes")
                        return (
                          <TimelineScreen
                            session={session}
                            palette={palette}
                            bottomInset={bottomInset}
                            hidden={hidden}
                            onOpenNote={(id) =>
                              dispatch({ type: "open-note", id })
                            }
                          />
                        );
                      if (tab === "tasks")
                        return (
                          <TasksScreen
                            session={session}
                            palette={palette}
                            bottomInset={bottomInset}
                            hidden={hidden}
                            onOpenNote={(id) =>
                              dispatch({ type: "open-note", id })
                            }
                          />
                        );
                      if (tab === "search")
                        return (
                          <SearchScreen
                            session={session}
                            palette={palette}
                            bottomInset={bottomInset}
                            hidden={hidden}
                            onOpenNote={(id) =>
                              dispatch({ type: "open-note", id })
                            }
                          />
                        );
                      return (
                        <ScrollView
                          automaticallyAdjustKeyboardInsets
                          contentInsetAdjustmentBehavior="never"
                          contentContainerStyle={{
                            padding: 20,
                            paddingBottom: bottomInset,
                            flexGrow: 1,
                          }}
                        >
                          {tab === "settings" ? (
                            <SettingsScreen
                              appearance={appearance}
                              onAppearance={setAppearance}
                              palette={palette}
                              onSignOut={signOut}
                            />
                          ) : (
                            <UpcomingScreen
                              name="Capture"
                              explanation="Direct text capture and persisted receipts arrive in native issue #126. Nothing is uploaded from this screen."
                              palette={palette}
                            />
                          )}
                        </ScrollView>
                      );
                    }}
                  />
                  {navigation.noteId ? (
                    <SafeAreaView
                      edges={["bottom"]}
                      {...backGesture.panHandlers}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        backgroundColor: palette.background,
                      }}
                    >
                      <NoteDetailScreen
                        key={navigation.noteId}
                        noteId={navigation.noteId}
                        session={session}
                        palette={palette}
                        onBack={() => dispatch({ type: "back" })}
                        onOpenSource={(id) =>
                          dispatch({ type: "open-source", id })
                        }
                      />
                    </SafeAreaView>
                  ) : null}
                </>
              )}
            </View>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
