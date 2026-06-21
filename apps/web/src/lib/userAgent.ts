function includesAny(value: string, patterns: string[]) {
  return patterns.some((pattern) => value.includes(pattern));
}

function truncate(value: string, maxLength = 48) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

export function describeUserAgent(userAgent: string | null) {
  const source = userAgent?.trim();
  if (!source) return "Unknown device";

  const browser = source.includes("Edg/")
    ? "Edge"
    : source.includes("OPR/")
      ? "Opera"
      : source.includes("Firefox/")
        ? "Firefox"
        : source.includes("Chrome/")
          ? "Chrome"
          : source.includes("Version/") && source.includes("Safari/")
            ? "Safari"
            : null;

  const os = includesAny(source, ["iPhone", "iPad", "iPod"])
    ? "iOS"
    : source.includes("Android")
      ? "Android"
      : source.includes("Mac OS X")
        ? "macOS"
        : source.includes("Windows NT")
          ? "Windows"
          : source.includes("Linux")
            ? "Linux"
            : null;

  if (browser && os) return `${browser} on ${os}`;
  if (browser) return browser;
  return os ? `${os} device` : truncate(source);
}
