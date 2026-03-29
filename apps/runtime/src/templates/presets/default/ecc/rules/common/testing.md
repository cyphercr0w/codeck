<!--
  Source: affaan-m/everything-claude-code (MIT License)
  https://github.com/affaan-m/everything-claude-code
  Author: Affaan Mustafa — integrated into Codeck with modifications.
-->

# Testing Requirements

## Minimum Test Coverage: 80%

Test Types (ALL required):
1. **Unit Tests** - Individual functions, utilities, components
2. **Integration Tests** - API endpoints, database operations
3. **E2E Tests** - Critical user flows (framework chosen per language)

## Test-Driven Development

MANDATORY workflow:
1. Write test first (RED)
2. Run test - it should FAIL
3. Write minimal implementation (GREEN)
4. Run test - it should PASS
5. Refactor (IMPROVE)
6. Verify coverage (80%+)

## Troubleshooting Test Failures

1. Use **tdd-guide** agent
2. Check test isolation
3. Verify mocks are correct
4. Fix implementation, not tests (unless tests are wrong)

## Agent Support

- **tdd-guide** - Use PROACTIVELY for new features, enforces write-tests-first

---

## Iron Law

**80% Coverage Is Non-Negotiable — measure before marking done.** Run the coverage tool. If below 80%, you are not done.

---

## Verification Before Completion

**Never claim success without fresh evidence.** Before saying "done", "fixed", "working", or "tests pass":

1. **Run the build** — if it doesn't compile, it's not done
2. **Run the tests** — if they don't pass, it's not done
3. **Show the output** — paste the actual result, not "it should work"

Banned phrases without accompanying verification output:
- "should work", "probably works", "seems to work"
- "I believe this fixes", "this likely resolves"
- "tests should pass", "the build should succeed"

If you catch yourself using these words, STOP and run the actual command instead.
