import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  parseNoteMarkdown,
  verifyInboxNotePath,
  NoteValidationError,
} from "@pce/core";
try {
  if (process.argv.length !== 3) throw new Error("Expected one file");
  const note = parseNoteMarkdown(await readFile(process.argv[2]));
  verifyInboxNotePath(`inbox/${basename(process.argv[2])}`, note.metadata);
  console.log(JSON.stringify({ valid: true }));
} catch (error) {
  console.log(
    JSON.stringify({
      valid: false,
      code: error instanceof NoteValidationError ? error.code : "INPUT_ERROR",
      ...(error instanceof NoteValidationError && error.field
        ? { field: error.field }
        : {}),
    }),
  );
  process.exitCode = 1;
}
