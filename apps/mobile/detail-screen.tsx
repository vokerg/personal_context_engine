import { useEffect, useState } from "react";
import {
  Alert,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from "react-native";
import {
  ApiRequestError,
  describeNotesError,
  getNote,
  getResearchForNote,
  getResearchReport,
  type NoteDetail,
  type ResearchRecord,
} from "@pce/api-client";
import {
  matchingReport,
  noteMetadata,
  orderReports,
  originalLabel,
  researchFailure,
  safeExternalUrl,
  validSourceNoteId,
  type ResearchListState,
} from "./detail-model";
import type { MobileSession } from "./session";
import type { Palette } from "./theme";
import { ActionButton, Panel, SectionTitle, StatusMessage } from "./ui";

async function readWithRefresh<T>(
  session: MobileSession,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof ApiRequestError) || error.status !== 401)
      throw error;
    if (!(await session.forceRefresh())) throw error;
    return read();
  }
}

function SectionLabel({ text, palette }: { text: string; palette: Palette }) {
  return (
    <Text
      accessibilityRole="header"
      style={{ color: palette.text, fontSize: 18, fontWeight: "700" }}
    >
      {text}
    </Text>
  );
}

function PlainText({ value, palette }: { value: string; palette: Palette }) {
  // Deliberately use a native Text node. Neither captured text nor research
  // findings are parsed as Markdown/HTML or executed as links.
  return (
    <Text
      selectable
      style={{ color: palette.text, fontSize: 16, lineHeight: 25 }}
    >
      {value}
    </Text>
  );
}

function ResearchContent({
  report,
  palette,
  onOpenSource,
}: {
  report: ResearchRecord;
  palette: Palette;
  onOpenSource: (id: string) => void;
}) {
  const [externalError, setExternalError] = useState("");
  const openExternal = (raw: string) => {
    const url = safeExternalUrl(raw);
    if (!url) {
      setExternalError("This source URL cannot be opened safely.");
      return;
    }
    setExternalError("");
    Alert.alert(
      "Open an external source?",
      "This opens a third-party website outside PCE.\n" + url,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Open website",
          onPress: () => {
            void Linking.openURL(url).catch(() =>
              setExternalError("Unable to open this website."),
            );
          },
        },
      ],
      { cancelable: true },
    );
  };
  return (
    <View style={{ gap: 14 }}>
      <Panel palette={palette}>
        <SectionLabel
          text="Saved research — not original input"
          palette={palette}
        />
        <Text style={{ color: palette.text, fontWeight: "600", fontSize: 17 }}>
          {report.title}
        </Text>
        <Text style={{ color: palette.secondary }}>
          {report.status === "COMPLETE"
            ? "Saved complete report"
            : "Saved draft — not complete"}
          {" · Revision " + report.revision + " · " + report.researchedAt}
        </Text>
        <Text selectable style={{ color: palette.secondary }}>
          {"Series: " +
            report.seriesId +
            "\nReport: " +
            report.reportId +
            "\nOrigin: " +
            report.origin +
            " · Saved: " +
            report.savedAt +
            "\nIndexing: " +
            report.indexing}
        </Text>
        <Text style={{ color: palette.secondary }}>
          {"Research by " +
            report.provenance.agent +
            (report.provenance.modelId
              ? " (" + report.provenance.modelId + ")"
              : "")}
        </Text>
        <SectionLabel text="Question" palette={palette} />
        <PlainText value={report.question} palette={palette} />
        <SectionLabel text="Findings" palette={palette} />
        <PlainText value={report.findings} palette={palette} />
        {report.limitations.length ? (
          <>
            <SectionLabel text="Limitations" palette={palette} />
            {report.limitations.map((line, i) => (
              <PlainText key={i} value={"• " + line} palette={palette} />
            ))}
          </>
        ) : null}
        <Text style={{ color: palette.secondary }}>
          {"PCE context: " +
            report.pceRetrieval.outcome.replace(/_/g, " ") +
            (report.pceRetrieval.mode ? " · " + report.pceRetrieval.mode : "") +
            (report.pceRetrieval.degradation
              ? " · Degraded: " + report.pceRetrieval.degradation
              : "")}
        </Text>
      </Panel>
      <Panel palette={palette}>
        <SectionLabel text="Cited sources" palette={palette} />
        {report.sources.length === 0 ? (
          <Text style={{ color: palette.secondary }}>
            No sources recorded in this version.
          </Text>
        ) : (
          report.sources.map((source) => (
            <View
              key={source.id}
              style={{
                gap: 6,
                paddingVertical: 8,
                borderBottomWidth: 1,
                borderBottomColor: palette.border,
              }}
            >
              <Text
                selectable
                style={{ color: palette.text, fontWeight: "600" }}
              >
                {source.id +
                  " · " +
                  (source.kind === "pce_note"
                    ? "PCE note"
                    : "External website")}
              </Text>
              {source.kind === "pce_note" ? (
                <>
                  <Text selectable style={{ color: palette.secondary }}>
                    {"Source note: " +
                      source.noteId +
                      "\nSource revision: " +
                      (source.sourceRevision ?? "not recorded") +
                      "\nReason: " +
                      source.rationale}
                  </Text>
                  <Text style={{ color: palette.secondary }}>
                    Opening the source shows its current authorized note, not a
                    historical snapshot of the cited revision.
                  </Text>
                  {validSourceNoteId(source.noteId) ? (
                    <ActionButton
                      label={"Open cited note " + source.id}
                      palette={palette}
                      secondary
                      onPress={() => onOpenSource(source.noteId)}
                    />
                  ) : null}
                </>
              ) : (
                <>
                  {source.title ? (
                    <Text style={{ color: palette.text }}>{source.title}</Text>
                  ) : null}
                  <Text selectable style={{ color: palette.secondary }}>
                    {source.url + "\nChecked: " + source.checkedAt}
                  </Text>
                  <ActionButton
                    label={"Open website " + source.id}
                    palette={palette}
                    secondary
                    disabled={!safeExternalUrl(source.url)}
                    onPress={() => openExternal(source.url)}
                  />
                </>
              )}
            </View>
          ))
        )}
        {externalError ? (
          <Text accessibilityRole="alert" style={{ color: palette.danger }}>
            {externalError}
          </Text>
        ) : null}
      </Panel>
      <Panel palette={palette}>
        <SectionLabel text="Claims and attribution" palette={palette} />
        {report.claims.length === 0 ? (
          <Text style={{ color: palette.secondary }}>
            No claims recorded in this version.
          </Text>
        ) : (
          report.claims.map((claim) => (
            <View key={claim.id} style={{ gap: 5 }}>
              <Text style={{ color: palette.secondary }}>
                {claim.id + " · " + claim.classification.replace(/_/g, " ")}
              </Text>
              <PlainText value={claim.text} palette={palette} />
              <Text selectable style={{ color: palette.secondary }}>
                {"Evidence: " +
                  (claim.sourceIds.length
                    ? claim.sourceIds.join(", ")
                    : "none recorded")}
              </Text>
            </View>
          ))
        )}
      </Panel>
    </View>
  );
}

/** Owner-gated source and history reads; nothing is cached or persisted on-device. */
export function NoteDetailScreen({
  noteId,
  session,
  palette,
  onBack,
  onOpenSource,
}: {
  noteId: string;
  session: MobileSession;
  palette: Palette;
  onBack: () => void;
  onOpenSource: (id: string) => void;
}) {
  const [note, setNote] = useState<NoteDetail | null>(null);
  const [noteError, setNoteError] = useState("");
  const [noteLoading, setNoteLoading] = useState(true);
  const [noteRevision, setNoteRevision] = useState(0);
  const [researchRevision, setResearchRevision] = useState(0);
  const [research, setResearch] = useState<ResearchListState>({
    kind: "loading",
  });
  const [selected, setSelected] = useState<ResearchRecord | null>(null);
  const [fullReport, setFullReport] = useState<ResearchRecord | null>(null);
  const [reportError, setReportError] = useState("");
  const [reportLoading, setReportLoading] = useState(false);

  useEffect(() => {
    let active = true;
    const abort = new AbortController();
    setNote(null);
    setNoteLoading(true);
    setNoteError("");
    setResearch({ kind: "loading" });
    setSelected(null);
    setFullReport(null);
    const options = {
      baseUrl: session.config.apiOrigin,
      getAccessToken: () => session.getAccessToken(),
      signal: abort.signal,
      timeoutMs: 12000,
    };
    void readWithRefresh(session, () => getNote(options, noteId)).then(
      (result) => {
        if (!active) return;
        setNote(result);
        setNoteLoading(false);
      },
      (error: unknown) => {
        if (!active) return;
        setNoteLoading(false);
        setNoteError(
          error instanceof ApiRequestError && error.status === 401
            ? "Session expired. Sign in again."
            : describeNotesError(error, true),
        );
      },
    );
    return () => {
      active = false;
      abort.abort();
    };
  }, [session, noteId, noteRevision]);

  useEffect(() => {
    if (!note || note.id !== noteId) return;
    let active = true;
    const abort = new AbortController();
    setResearch({ kind: "loading" });
    setSelected(null);
    setFullReport(null);
    const options = {
      baseUrl: session.config.apiOrigin,
      getAccessToken: () => session.getAccessToken(),
      signal: abort.signal,
      timeoutMs: 12000,
    };
    void readWithRefresh(session, () =>
      getResearchForNote(options, noteId),
    ).then(
      (result) => {
        if (!active) return;
        // Never show a report bound to an unrelated parent note.
        const matching = orderReports(
          result.reports.filter((r) => r.parentNoteId === noteId),
        );
        if (matching.length !== result.reports.length) {
          setResearch({
            kind: "error",
            message: "Research response did not match this note.",
          });
          return;
        }
        setResearch({ kind: "ready", reports: matching });
        setSelected(matching[0] ?? null);
      },
      (error: unknown) => {
        if (active) setResearch(researchFailure(error));
      },
    );
    return () => {
      active = false;
      abort.abort();
    };
  }, [session, noteId, note, researchRevision]);

  useEffect(() => {
    if (!selected || research.kind !== "ready") return;
    let active = true;
    const abort = new AbortController();
    setFullReport(null);
    setReportLoading(true);
    setReportError("");
    const options = {
      baseUrl: session.config.apiOrigin,
      getAccessToken: () => session.getAccessToken(),
      signal: abort.signal,
      timeoutMs: 12000,
    };
    void readWithRefresh(session, () =>
      getResearchReport(options, selected.reportId),
    ).then(
      (report) => {
        if (!active) return;
        setReportLoading(false);
        if (!matchingReport(selected, report, noteId)) {
          setReportError(
            "This saved report changed since the history was loaded. Reload research.",
          );
        } else {
          setFullReport(report);
        }
      },
      (error: unknown) => {
        if (!active) return;
        setReportLoading(false);
        setReportError(
          researchFailure(error).kind === "disabled"
            ? "This report is no longer available. Reload research."
            : "Unable to retrieve the selected report. Retry or reload research.",
        );
      },
    );
    return () => {
      active = false;
      abort.abort();
    };
  }, [session, noteId, selected, research.kind]);

  return (
    <ScrollView
      style={{ flex: 1 }}
      alwaysBounceVertical
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: 20, gap: 14, flexGrow: 1 }}
      refreshControl={
        <RefreshControl
          refreshing={noteLoading}
          onRefresh={() => setNoteRevision((v) => v + 1)}
        />
      }
    >
      <ActionButton label="Back" palette={palette} secondary onPress={onBack} />
      <SectionTitle palette={palette}>Note detail</SectionTitle>
      {noteLoading ? (
        <StatusMessage palette={palette} heading="Loading note…" />
      ) : null}
      {noteError ? (
        <StatusMessage
          palette={palette}
          heading="Note unavailable"
          description={noteError}
          alert
          retry={() => setNoteRevision((x) => x + 1)}
        />
      ) : null}
      {note ? (
        <>
          <Panel palette={palette}>
            <Text
              accessibilityRole="header"
              style={{ color: palette.text, fontSize: 22, fontWeight: "700" }}
            >
              {note.title}
            </Text>
            <SectionLabel text="Parsed summary — derived" palette={palette} />
            <PlainText value={note.summary} palette={palette} />
            <SectionLabel text="Capture metadata" palette={palette} />
            {noteMetadata(note).map((line) => (
              <Text key={line} selectable style={{ color: palette.secondary }}>
                {line}
              </Text>
            ))}
          </Panel>
          <Panel palette={palette}>
            <SectionLabel
              text="Original user input — immutable"
              palette={palette}
            />
            <PlainText value={originalLabel(note)} palette={palette} />
            <SectionLabel
              text="Stored note body — separate from original input"
              palette={palette}
            />
            <PlainText value={note.body} palette={palette} />
          </Panel>
          <SectionTitle palette={palette}>Research history</SectionTitle>
          {research.kind === "loading" ? (
            <StatusMessage
              palette={palette}
              heading="Loading saved research…"
            />
          ) : null}
          {research.kind === "disabled" ? (
            <StatusMessage
              palette={palette}
              heading="Research unavailable"
              description="The research endpoint is not available for this note or is disabled on the API."
            />
          ) : null}
          {research.kind === "error" ? (
            <StatusMessage
              palette={palette}
              heading="Could not load research"
              description={research.message}
              alert
              retry={() => setResearchRevision((x) => x + 1)}
            />
          ) : null}
          {research.kind === "ready" ? (
            <>
              <ActionButton
                label="Reload research"
                palette={palette}
                secondary
                onPress={() => setResearchRevision((x) => x + 1)}
              />
              {research.reports.length === 0 ? (
                <StatusMessage
                  palette={palette}
                  heading="No saved research"
                  description="No research versions are stored for this note."
                />
              ) : (
                <Panel palette={palette}>
                  <SectionLabel
                    text="Saved report versions"
                    palette={palette}
                  />
                  {research.reports.map((version) => (
                    <Pressable
                      key={version.reportId}
                      accessibilityRole="button"
                      accessibilityLabel={
                        "Select research revision " +
                        version.revision +
                        " of " +
                        version.seriesId
                      }
                      accessibilityState={{
                        selected: version.reportId === selected?.reportId,
                      }}
                      onPress={() => setSelected(version)}
                      style={({ pressed }) => ({
                        borderWidth: 1,
                        borderColor:
                          version.reportId === selected?.reportId
                            ? palette.primary
                            : palette.border,
                        borderRadius: 10,
                        padding: 12,
                        minHeight: 48,
                        opacity: pressed ? 0.75 : 1,
                        backgroundColor:
                          version.reportId === selected?.reportId
                            ? palette.subtle
                            : palette.surface,
                      })}
                    >
                      <Text style={{ color: palette.text, fontWeight: "600" }}>
                        {version.title + " · v" + version.revision}
                      </Text>
                      <Text style={{ color: palette.secondary }}>
                        {version.status +
                          " · " +
                          version.researchedAt +
                          " · " +
                          version.origin}
                      </Text>
                    </Pressable>
                  ))}
                </Panel>
              )}
              {reportLoading ? (
                <StatusMessage
                  palette={palette}
                  heading="Loading selected report…"
                />
              ) : null}
              {reportError ? (
                <StatusMessage
                  palette={palette}
                  heading="Report unavailable"
                  description={reportError}
                  alert
                  retry={() => setResearchRevision((x) => x + 1)}
                />
              ) : null}
              {fullReport && fullReport.reportId === selected?.reportId ? (
                <ResearchContent
                  key={fullReport.reportId}
                  report={fullReport}
                  palette={palette}
                  onOpenSource={onOpenSource}
                />
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}
