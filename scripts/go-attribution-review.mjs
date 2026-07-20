export function isRfc3339Utc(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(value);
  if (!match) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const parsed = new Date(timestamp);
  return parsed.getUTCFullYear() === Number(match[1])
    && parsed.getUTCMonth() + 1 === Number(match[2])
    && parsed.getUTCDate() === Number(match[3])
    && parsed.getUTCHours() === Number(match[4])
    && parsed.getUTCMinutes() === Number(match[5])
    && parsed.getUTCSeconds() === Number(match[6]);
}

export function validateGoAttributionReview(review) {
  if (!review || !["pending", "approved"].includes(review.status)) {
    throw new Error("manifest review status is invalid");
  }
  if (review.status === "pending") {
    if (review.approvedBy != null || review.approvedAt != null) {
      throw new Error("pending manifest must not contain approval identity or date");
    }
    return review;
  }
  if (typeof review.approvedBy !== "string" || review.approvedBy.trim() === "") {
    throw new Error("approved manifest must identify the qualified reviewer or organization");
  }
  if (!isRfc3339Utc(review.approvedAt)) {
    throw new Error("approved manifest must record an RFC3339 UTC approval timestamp");
  }
  return review;
}
