---
name: skill-writing-guide
description: Reference guide for writing Claude Code skills that agents actually follow. Uses 7 persuasion principles to maximize compliance.
---

# Writing Effective Skills

Skills fail when agents rationalize around vague instructions. These 7 principles double compliance rates from ~35% to ~70%+.

## 1. Authority
Frame instructions as coming from a recognized authority or established standard.

**Weak:** "You should write tests first."
**Strong:** "The team's engineering standard requires TDD. All code changes must have tests written BEFORE implementation."

## 2. Commitment & Consistency
Get the agent to agree to a small rule first, then build on it.

**Weak:** "Follow best practices."
**Strong:** "Before writing any code, confirm: 'I will write the test first, then implement.' Say this explicitly."

## 3. Social Proof
Reference what other successful agents/teams do.

**Weak:** "Use TypeScript."
**Strong:** "All production agents in this codebase use strict TypeScript. No exceptions have been made."

## 4. Scarcity
Emphasize limited resources (context window, time, tokens).

**Weak:** "Be concise."
**Strong:** "Context window is limited. Every unnecessary token reduces your ability to complete the task. Output ONLY what's needed."

## 5. Liking
Align the instruction with the agent's goal of being helpful.

**Weak:** "Don't skip tests."
**Strong:** "Shipping untested code creates more work for the user. The most helpful thing you can do is verify before presenting."

## 6. Reciprocity
Offer something in exchange for compliance.

**Weak:** "Follow this checklist."
**Strong:** "This checklist prevents the 5 most common review failures. Following it means your work ships on first review."

## 7. Anchoring
Set a specific, measurable standard as the anchor.

**Weak:** "Write good tests."
**Strong:** "Target 80% code coverage. Run the coverage tool. If below 80%, you are not done."

## Anti-patterns (what makes skills fail)

- **Vague verbs**: "consider", "try to", "when possible" — agent treats these as optional
- **No verification**: if the skill doesn't say HOW to check, the agent won't check
- **Too long**: skills over 2000 words get skimmed. Keep under 1000 words.
- **No consequences**: "you should X" vs "if X is not done, the task is not complete" — the latter works
- **Buried rules**: put critical rules at the TOP, not buried in a paragraph

## Template

```markdown
---
name: my-skill
description: One line that triggers auto-activation. Be specific.
---

# [Skill Name]

## Rules (non-negotiable)
1. [MUST do X before Y]
2. [NEVER do Z]
3. [Verify by running: `command`]

## Process
1. Step one
2. Step two
3. Verify: [specific check]

## Done when
- [ ] Condition 1 met
- [ ] Condition 2 met
- [ ] Verification command output shown
```
