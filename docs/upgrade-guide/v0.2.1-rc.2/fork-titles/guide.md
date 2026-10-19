---
kind: upgrade-guide
description: "Fork titles follow their own prompts and sidebar rows stay with their source family."
---

# Fork titles and sidebar families

English | [中文](guide.zh.md)

## Change

Sidebar and Chat Branch actions create forks without renaming the inherited title to a numbered user title. A fork keeps its inherited title until its first own eligible human prompt, then receives its own fallback and optional generated title. An inherited user rename does not prevent this generation; a rename made in the fork still pins its title. Sidebar rows include a fork identifier and nest visible descendants under their source. Family adjacency takes precedence over individual pin and manual positions.

## Migration

1. No configuration or Session-log migration is required. Existing logged titles remain intact.
2. If an existing fork has a numbered user title that you want generated again, use the title provider's explicit `ctx.sessionTitle.refresh(session)` operation. Otherwise keep or rename it normally.
3. Create a fork through Branch, send a new prompt, and confirm its title follows its own prompt while the sidebar places it below its source.
