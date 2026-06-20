const COMMON_PASSWORDS = new Set(["password123456", "changeme123456", "dockermender", "dockermender"]);

export function validatePasswordStrength(password: string) {
  const issues: string[] = [];
  if (password.length < 12) issues.push("Use at least 12 characters");
  if (!/[a-z]/.test(password)) issues.push("Include a lowercase letter");
  if (!/[A-Z]/.test(password)) issues.push("Include an uppercase letter");
  if (!/[0-9]/.test(password)) issues.push("Include a number");
  if (!/[^A-Za-z0-9]/.test(password)) issues.push("Include a symbol");
  if (COMMON_PASSWORDS.has(password.toLowerCase())) issues.push("Choose a less common password");
  return issues;
}
