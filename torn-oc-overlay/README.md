# Torn OC Join Overlay

Read-only userscript. Shows, on each open slot of the faction OC recruiting list, whether your own CPR meets the faction's minimum.

## Install
- **Desktop:** install Tampermonkey, create a new script, paste `torn-oc-join-overlay.user.js`, save. Open Faction > Crimes > Recruiting.
- **TornPDA:** Settings > Advanced > User scripts > add a script, paste the file.

## Update the requirements (no source edits)
Click **Requirements** in the bar above the list:
- Edit the JSON and press **Save** (bad JSON or bad numbers are rejected with a message).
- **Add / change one number:** fill OC name, level, role (or `*`) and min, press the button.
- **Import pasted JSON:** replace everything, or merge (adds/overrides OCs).
- **Import from URL:** a raw GitHub/Gist link; tick auto-check to look once an hour and only replace when its `lastUpdated` is newer.
- **Reset to built-in defaults** restores the seed data. The default minimum for unlisted level 7-10 OCs is its own field.

Badges: green = meets it, red = short by N, amber/dashed = OC or role not listed (default applied). Levels 5-6 always pass, 1-4 show nothing.

## Selectors: not yet verified against live Torn
The script was written without access to torn.com. It finds things by text (`N/10`, `Join`, numbers), not class names. If nothing shows up, open Requirements > **Copy debug dump**, then either send it over or fill in `SELECTOR_HINTS` at the top of the script.

## API mode (off by default)
Cross-check only; the CPR always comes from the page. The v2 endpoint, field names (`checkpoint_pass_rate`, `position_info`) and the "empty slots return 0" behaviour are from memory and have **not** been verified with a real call.
