// Vercel: exit 0 skips, exit 1 builds. Fail closed for unknown/non-main refs.
process.exit(process.env.VERCEL_GIT_COMMIT_REF === "main" ? 1 : 0);
