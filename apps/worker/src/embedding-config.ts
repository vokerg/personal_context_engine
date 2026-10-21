/** No DB access, key logging, or note processing during config validation. */
export function embeddingConfig(env: NodeJS.ProcessEnv, recurring = false) {
  if (
    env.PCE_EMBEDDINGS_ENABLED !== "true" ||
    env.PCE_EMBEDDING_EGRESS_APPROVED !== "I_APPROVE_PRIVATE_TEXT_TO_OPENAI"
  )
    throw new Error("Embedding egress is not approved.");
  if (
    (env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small") !==
      "text-embedding-3-small" ||
    !env.DATABASE_URL
  )
    throw new Error("Unsupported embedding model or missing DB.");
  const owner = env.PCE_EMBEDDING_OWNER_SUBJECT;
  const key = env.OPENAI_API_KEY;
  const project = env.OPENAI_PROJECT_ID;
  const afterNoteId = env.PCE_EMBEDDING_AFTER_NOTE_ID;
  if (
    !owner ||
    !/^[A-Za-z0-9][A-Za-z0-9._:|@-]{0,127}$/.test(owner) ||
    !key ||
    !project ||
    (afterNoteId !== undefined &&
      (recurring || !/^[0-9a-zA-Z-]{1,36}$/.test(afterNoteId)))
  )
    throw new Error(
      "Invalid owner, cursor or server-side embedding credentials.",
    );
  return { owner, key, project, afterNoteId };
}
