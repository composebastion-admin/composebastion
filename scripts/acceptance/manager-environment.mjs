export const managedDatabaseTransitionComment =
  "# ComposeBastion managed legacy database transition";

export function hasManagedCanonicalDatabaseOverride(contents) {
  const lines = contents.split(/\r?\n/);
  return lines.some((line, index) => (
    line === managedDatabaseTransitionComment
      && lines[index + 1] === "DATABASE_URL="
  ));
}
