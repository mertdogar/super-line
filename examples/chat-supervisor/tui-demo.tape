# VHS tape for the TUI demo GIF (https://github.com/charmbracelet/vhs).
# Needs: a running server (pnpm dev:server) and a seeded session cache at
# /tmp/tui-tape-cache.json (sign up once via the cockpit or the smoke).
# Record: vhs tui-demo.tape   (from examples/chat-supervisor)

Output tui-demo.gif

Set Shell bash
Set FontSize 14
Set Width 1240
Set Height 780
Set Padding 10
Set Framerate 20
Set TypingSpeed 55ms
Set WindowBar Colorful
Set BorderRadius 8

Hide
Type "export CHAT_SUPERVISOR_CACHE=/tmp/tui-tape-cache.json && clear"
Enter
Sleep 1s
Show

Type "pnpm tui"
Enter
Sleep 7s

Type "Put three sticky notes on the canvas for the launch: one for polish, one for docs, one for release day."
Sleep 500ms
Enter

Wait+Screen@90s /Write resource/
Sleep 12s

# Into the pane: pick a note, nudge it, peek at the doc tab.
Tab
Sleep 1s
Right
Sleep 700ms
Right
Sleep 700ms
Type "m"
Sleep 700ms
Down
Sleep 400ms
Down
Sleep 400ms
Right
Sleep 400ms
Right
Sleep 600ms
Enter
Sleep 1s
Type "2"
Sleep 2500ms
Type "1"
Sleep 1500ms
Escape
Sleep 1s

# The slash popover, then rest on the final frame.
Type "/"
Sleep 2s
Escape
Sleep 3s
