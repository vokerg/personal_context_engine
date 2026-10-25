import { confirmationBenchmark } from "./confirmation.mjs";
// Frozen keyword-focused confirmation after feedback exposed unrelated tails.
// Includes broad/ambiguous keywords and no-shared-word conceptual queries.
const specs = [
  ["observatory", "observatory", ["observatory-positive"]],
  ["harvest", "harvest", ["orchard-positive"]],
  ["costume", "костюмами", ["theatre-positive"]],
  ["rover", "rover", ["robot-positive", "robot-hard-negative"]],
  ["kiln", "печью", ["ceramics-positive"]],
  ["bergen", "Bergen", ["kayak-positive", "kayak-hard-negative"]],
  ["hive", "hive", ["bees-positive", "bees-hard-negative"]],
  ["bow", "смычком", ["violin-positive", "violin-hard-negative"]],
  ["tickets", "tickets", ["archive-positive", "archive-hard-negative"]],
  ["greenhouse", "теплицей", ["garden-positive", "garden-hard-negative"]],
  ["museum", "museum", ["museum-positive", "museum-hard-negative"]],
  ["binoculars", "биноклем", ["telescope-positive"]],
  ["inverter", "inverter", ["solar-positive", "solar-hard-negative"]],
  ["jazz", "джаз", ["jazz-positive", "jazz-hard-negative"]],
  ["harbor", "harbor", ["harbor-positive", "harbor-hard-negative"]],
  ["cellar", "погреб", ["cheese-positive", "cheese-hard-negative"]],
  ["electricity", "power", ["solar-positive"]],
  ["water", "влага", ["garden-positive"]],
  ["translation", "translation", ["museum-positive"]],
  ["unknown", "quasarship", []],
];
export const keywordConfirmationBenchmark = {
  version: 1,
  documents: confirmationBenchmark.documents,
  queries: specs.map(([id, query, positives]) => ({
    id: "keyword-" + id,
    query,
    split: "keyword",
    family: id,
    category:
      positives.length === 0
        ? "no_answer"
        : positives.length > 1
          ? "ambiguous"
          : id === "electricity" || id === "water" || id === "translation"
            ? "conceptual"
            : "keyword",
    relevance: Object.fromEntries(positives.map((id) => [id, 3])),
  })),
};
