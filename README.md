# Unprompted Messages

SillyTavern extension that lets the current character occasionally send an unprompted message.

## Quick Install

1. In SillyTavern, open **Extensions -> Install extension**
2. Paste this URL: https://github.com/shikaku2/st-unprompted

## Behavior

- Checks every configured number of minutes. Default: 30.
- Enforces a per-chat cooldown. Default: 180 minutes.
- Refuses to send if there are already too many assistant messages in a row. Default: 2.
- Picks one enabled prompt by relative weight. A prompt with weight 5 is selected with chance `5 / total enabled weight`.
- Uses `Generate('normal', { automatic_trigger: true, quiet_prompt, quietToLoud: true })`, so the message is saved as a normal character reply; lorebooks/context/extensions/etc. also works normally.
- Optionally shows browser notifications for unprompted messages when site notification permission is granted.

## Custom Macros

Prompt text can use normal SillyTavern macros plus these extension macros:

- `[lastmessages=N]`: inserts the last N non-system chat messages.
- `[1d]`: inserts messages from the last day.
- `[168h]`: inserts messages from the last 168 hours.
- `[1m]`: inserts messages from the last month, treated as 30 days.
- `[1m2d6h]`: combined month/day/hour duration.

In duration macros, `m` means months, `d` means days, and `h` means hours.
