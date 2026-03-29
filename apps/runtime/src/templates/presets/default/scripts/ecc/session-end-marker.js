#!/usr/bin/env node
"use strict";

// Session end marker — no-op. Originally did stdin passthrough which broke
// Claude Code's hook JSON validation. Now intentionally empty.
// The run() export is required by run-with-flags.js in-process execution path.

function run() {}

if (require.main === module) {
	// Nothing to do when invoked directly
}

module.exports = { run };
