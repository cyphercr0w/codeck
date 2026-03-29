#!/usr/bin/env node
/**
 * PreToolUse hook — RTK bash command rewriting.
 * Rewrites Bash tool calls to run through RTK for token-compressed output.
 * Only active when RTK binary is installed.
 */
import { execFileSync } from "child_process";

// Check if RTK is available (cached after first check)
let rtkAvailable = null;
function hasRtk() {
  if (rtkAvailable !== null) return rtkAvailable;
  try {
    execFileSync("which", ["rtk"], { stdio: "ignore" });
    rtkAvailable = true;
  } catch {
    rtkAvailable = false;
  }
  return rtkAvailable;
}

let input = "";
for await (const chunk of process.stdin) input += chunk;

try {
  const data = JSON.parse(input);

  // Only intercept Bash tool calls
  if (data.tool_name !== "Bash") {
    process.exit(0);
  }

  if (!hasRtk()) {
    process.exit(0);
  }

  const command = data.tool_input?.command || "";

  // Skip if already contains rtk
  if (command.includes("rtk ")) {
    process.exit(0);
  }

  // Skip interactive or special commands that shouldn't be rewritten
  const skipPatterns = [
    /^cd\b/,
    /^export\b/,
    /^source\b/,
    /^eval\b/,
    /^npm run\b.*start/,
    /^npm run\b.*dev/,
    /^npx\b.*vite/,
    /^echo\b/,
    /^printf\b/,
    /^read\b/,
  ];

  if (skipPatterns.some((p) => p.test(command))) {
    process.exit(0);
  }

  // Use rtk rewrite to get the optimal RTK equivalent.
  // rtk rewrite exits 0 with rewritten command if supported, exits 1 if no equivalent.
  // Pass command as a single argument to avoid shell injection.
  let rewritten;
  try {
    rewritten = execFileSync("rtk", ["rewrite", command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // rtk rewrite returned non-zero — no RTK equivalent, pass through unchanged
    process.exit(0);
  }

  if (!rewritten || rewritten === command) {
    process.exit(0);
  }

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        modifiedToolInput: {
          command: rewritten,
        },
      },
    })
  );
} catch {
  process.exit(0);
}
