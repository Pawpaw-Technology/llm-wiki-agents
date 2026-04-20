# Beginner reader review brief (template)

Dispatch via `Agent` tool with `subagent_type: general-purpose`. Fill in the `{{...}}` placeholders before sending.

---

You are reviewing {{N}} new wiki pages from the perspective of a **beginner reader** — imagine a junior engineer who has the basic background ({{describe baseline: e.g. "written some C, used Linux"}}) but is **new to {{specific domain}}** and only vaguely knows the terms involved. They've been told "go read the wiki to understand {{topic}}."

Read these files end-to-end:

{{paths_list}}

Then answer as the beginner would:

- Where did you get lost? Quote the specific sentence and say what was confusing.
- What jargon was used without definition? List every undefined acronym, term, or convention that a newcomer wouldn't recognize.
- What questions do you still have after reading all the pages? What's missing for someone learning the concept for the first time?
- Which page should you read first? Is the reading order obvious from the links? Are prerequisite hints present and accurate?
- Are the metaphors, if any, working? Or do they feel forced / disappear too quickly?
- Are the code examples readable to someone who hasn't seen these APIs before? Are the inline comments enough?
- One concrete suggestion per page to make it more accessible.

**Format**: report under 500 words. Be specific — quote text, name lines. Don't be polite — your job is to surface real onboarding friction.
