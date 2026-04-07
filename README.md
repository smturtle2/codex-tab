# Codex Tab

<p align="center">
  Codex-backed ghost text autocomplete for <code>code-server</code>.
</p>

<p align="center">
  <a href="https://github.com/smturtle2/codex-tab/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/smturtle2/codex-tab?display_name=tag"></a>
  <a href="https://github.com/smturtle2/codex-tab/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/smturtle2/codex-tab"></a>
  <img alt="code-server" src="https://img.shields.io/badge/code--server-only-1275D1">
  <img alt="models" src="https://img.shields.io/badge/models-live%20list-blue">
  <img alt="reasoning" src="https://img.shields.io/badge/reasoning-configurable-0A7B83">
</p>

<p align="center">
  Runs on the <code>code-server</code> host, signs in with Codex OAuth PKCE, stores its own session, and talks directly to the Codex backend for model discovery and inline completions.
</p>

## Quick Start

Install the latest release into `code-server`:

```bash
tmpfile="$(mktemp -t codex-tab-XXXXXX.vsix)" && \
curl -fL "https://github.com/smturtle2/codex-tab/releases/latest/download/codex-tab-0.0.8.vsix" -o "$tmpfile" && \
code-server --install-extension "$tmpfile" && \
rm -f "$tmpfile"
```

Release links:

- Latest release: [github.com/smturtle2/codex-tab/releases/latest](https://github.com/smturtle2/codex-tab/releases/latest)
- Direct VSIX asset: [codex-tab-0.0.8.vsix](https://github.com/smturtle2/codex-tab/releases/latest/download/codex-tab-0.0.8.vsix)

Then reload `code-server`, open the Command Palette, run `Codex Tab: Sign In`, finish the browser flow, paste the callback URL, and run `Codex Tab: Check Setup`.

## What It Does

- Inline ghost text completions inside `code-server`
- Server-side execution with `extensionKind: ["workspace"]`
- Direct `https://chatgpt.com/backend-api/codex/models` and `/responses` calls
- Live model list loaded from the Codex backend for auto selection and the picker
- Explicit model IDs can be used directly with `/responses`, even when absent from the live model list
- Rich model metadata parsing for nested model-list payloads
- Configurable reasoning effort with model-aware selection
- Backend requests include the packaged extension `client_version`
- Model discovery failures now include response-shape diagnostics in logs/errors
- Extension-owned OAuth PKCE sign-in stored in VS Code secret storage
- No thread-based `codex app-server` generation flow

## Requirements

- `code-server`
- Access to at least one Codex-backed model
- Outbound network access from the `code-server` host to OpenAI endpoints

## How It Works

`Codex Tab` runs on the same machine as your `code-server` extension host. It starts a Codex OAuth PKCE sign-in flow from the command palette, stores refreshable credentials in VS Code secret storage, loads the live model list from the Codex backend when it needs an account default model or picker metadata, tags Codex backend requests with the packaged extension version, runs a setup probe against the effective model, and requests streamed plain-text completions from the Codex responses backend. Nothing runs in the browser beyond the normal `code-server` UI and the login redirect.

## Commands

- `Codex Tab: Sign In`
- `Codex Tab: Sign Out`
- `Codex Tab: Check Setup`
- `Codex Tab: Reload Auth`
- `Codex Tab: Open Logs`
- `Codex Tab: Select Model`
- `Codex Tab: Select Reasoning Effort`
- `Codex Tab: Accept Next Word`

## Settings

- `codexAutocomplete.enabled`
- `codexAutocomplete.model`
  Empty means "use account default". You can also set a custom model ID directly.
- `codexAutocomplete.reasoningEffort`
- `codexAutocomplete.debounceMs`
- `codexAutocomplete.maxPrefixChars`
- `codexAutocomplete.maxSuffixChars`
- `codexAutocomplete.requestTimeoutMs`

## Development

```bash
npm install
npm run build
npm run typecheck
npm test
npm run package:vsix
```

Install a locally packaged build with:

```bash
code-server --install-extension ./codex-tab-0.0.8.vsix
```

## License

Apache-2.0
