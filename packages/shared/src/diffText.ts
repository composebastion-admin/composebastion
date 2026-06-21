export type DiffLine = {
  type: "add" | "remove" | "change";
  line: number;
  text: string;
};

export function diffText(before: string, after: string): DiffLine[] {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const max = Math.max(beforeLines.length, afterLines.length);
  const changes: DiffLine[] = [];

  for (let index = 0; index < max; index += 1) {
    const left = beforeLines[index];
    const right = afterLines[index];
    if (left === right) continue;
    if (left === undefined) {
      changes.push({ type: "add", line: index + 1, text: right ?? "" });
    } else if (right === undefined) {
      changes.push({ type: "remove", line: index + 1, text: left });
    } else {
      changes.push({ type: "change", line: index + 1, text: `${left} -> ${right}` });
    }
  }

  return changes;
}
