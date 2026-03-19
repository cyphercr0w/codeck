# Rules

## Code Integrity
- Never speculate about code you haven't read. Open the file first.
- Never hardcode secrets. Reference by variable name (`$ENV_VAR`), never by value.
- Validate all external input before processing.
- Use parameterized queries for all database operations.

## Error Recovery
- Read the FULL error message before acting.
- Try a DIFFERENT approach on failure — never repeat the same thing.
- After 3 failed attempts, stop and explain the problem.

## Work Style
- Only create files the user requests. Skip docs and READMEs unless asked.
- Make trivial decisions yourself. Confirm only consequential ones.
- Wait for explicit request before committing.
- When done, state what changed. Be brief.
