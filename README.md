# Unprompted Messages

SillyTavern extension that lets the current character occasionally send an unprompted message.

## Quick Install

1. In SillyTavern, open **Extensions -> Install extension**
2. Paste this URL: https://github.com/shikaku2/st-unprompted

## Behavior

- Checks every configured number of minutes. Default: 30.
- Enforces a per-chat cooldown. Default: 180 minutes.
- Refuses to send if there are already too many assistant messages in a row. Default: 2.
- Refuses to send while the chat compose box has a draft, so automatic messages do not wipe what you are typing.
- Adds a `[saynothing]` escape hatch to each unprompted prompt. If the generated unprompted reply contains `[saynothing]`, the extension deletes that reply and pauses further unprompted replies in that chat until the user sends the next message.
- Picks one enabled prompt by relative weight. A prompt with weight 5 is selected with chance `5 / total enabled weight`.
- Uses `Generate('normal', { automatic_trigger: true, quiet_prompt, quietToLoud: true })`, so the message is saved as a normal character reply; lorebooks/context/extensions/etc. also works normally.
- Optionally shows browser notifications for unprompted messages when site notification permission is granted.

## Custom Macros

Prompt text can use normal SillyTavern macros plus these extension macros:

- `[lastmessages=N]`: inserts the last N non-system chat messages.
- `[lastexchanges=N]`: inserts the last N exchanges. One normal exchange starts with one user message and includes every following non-system AI message until the next user message, so continued AI replies stay with that exchange. If the chat starts with AI messages before the first user message, that opening AI-only block counts as one exchange when needed.
- `[1d]`: inserts messages from the last day.
- `[168h]`: inserts messages from the last 168 hours.
- `[1m]`: inserts messages from the last month, treated as 30 days.
- `[1m2d6h]`: combined month/day/hour duration.

In duration macros, `m` means months, `d` means days, and `h` means hours.

## `[saynothing]`

Use `[saynothing]` in an unprompted prompt as an instruction to the AI, not as text for the character to say.

Example prompt text:

```text
Continue the conversation naturally. If it is not natural to say anything, or if {{user}} said "I'll message you later" or "wait for me to message you first", output only [saynothing].
Context:
[lastexchanges=3]
```

When an unprompted AI reply contains `[saynothing]`, the extension:

- deletes that AI reply from the chat;
- does not show a browser notification for it;
- prevents more unprompted replies in that chat until the user sends another message.

The extension also appends this instruction automatically to unprompted generations, so existing prompts can use the behavior without being rewritten.
