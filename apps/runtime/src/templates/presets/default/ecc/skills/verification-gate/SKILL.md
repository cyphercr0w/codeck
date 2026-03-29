---
name: verification-gate
description: Gate that blocks success claims without fresh evidence. Enforces run-the-command-show-the-output before marking work done.
---

# Verification Gate

## Rules (non-negotiable)

1. Before saying "done", "fixed", "working", or "tests pass" — RUN THE COMMAND and SHOW THE OUTPUT.
2. If the build doesn't compile, it's not done.
3. If the tests don't pass, it's not done.

## Banned phrases without accompanying output

These phrases are NEVER allowed without the actual command output in the same message:
- "should work", "probably works", "seems to work"
- "I believe this fixes", "this likely resolves"
- "tests should pass", "the build should succeed"

If you catch yourself using these words, STOP and run the actual command instead.

## Verification checklist

Before marking any task complete:
- [ ] `npm run build` passes (or equivalent build command)
- [ ] Tests pass: `npm test` (or equivalent)
- [ ] Output shown in response (not "it should work")
- [ ] No TypeScript errors: `npx tsc --noEmit`

## Escalation

If verification fails:
1. Read the error message
2. Fix the issue
3. Re-run verification
4. Only mark done when ALL checks pass with shown output
