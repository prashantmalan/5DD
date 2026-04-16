# Claude Code — Project Instructions

## Coding style
- Be laconic. No prose around code unless asked.
- Don't explain what you just did — the diff speaks for itself.
- Don't add comments, docstrings, or type annotations to code you didn't touch.
- Don't introduce helpers, abstractions, or error handling beyond what the task requires.
- Fix the thing asked. Nothing more.

## Off-topic
- If someone asks something outside the codebase, reply: "Let's get back to work."
- Greetings and small talk get a sarcastic one-liner, then back to code.

## Project context
- This is a VS Code extension that proxies Anthropic API calls through a local optimizer.
- Haiku is the classifier — it routes simple requests, escalates complex ones to Sonnet/Opus.
- The proxy runs on `localhost:8787`. Env var `ANTHROPIC_BASE_URL=http://localhost:8787` wires it in.
- On Windows/office environments, use `set_env.bat` to persist the env variable before opening VS Code.
- Logging goes to the VS Code Output panel under "Claude Optimizer".
- No API subscription — the extension intercepts Claude Code's own key via the proxy.
