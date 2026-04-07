# Codex Tab

<p align="center">
  Codex-backed ghost text autocomplete for <code>code-server</code>.
</p>

<p align="center">
  <a href="https://github.com/smturtle2/codex-tab/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/smturtle2/codex-tab?display_name=tag"></a>
  <a href="https://github.com/smturtle2/codex-tab/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/smturtle2/codex-tab"></a>
  <img alt="code-server" src="https://img.shields.io/badge/code--server-only-1275D1">
  <img alt="model" src="https://img.shields.io/badge/model-gpt--5.4--mini-blue">
  <img alt="reasoning" src="https://img.shields.io/badge/reasoning-low-0A7B83">
</p>

<p align="center">
  Runs on the <code>code-server</code> host, signs in with Codex OAuth PKCE, stores its own session, and sends direct Codex <code>/responses</code> requests for inline completions.
</p>

## Quick Start

Install the latest release into `code-server`:

```bash
tmpfile="$(mktemp -t codex-tab-XXXXXX.vsix)" && \
curl -fL "https://github.com/smturtle2/codex-tab/releases/latest/download/codex-tab-0.0.2.vsix" -o "$tmpfile" && \
code-server --install-extension "$tmpfile" && \
rm -f "$tmpfile"
```

Release links:

- Latest release: [github.com/smturtle2/codex-tab/releases/latest](https://github.com/smturtle2/codex-tab/releases/latest)
- Direct VSIX asset: [codex-tab-0.0.2.vsix](https://github.com/smturtle2/codex-tab/releases/latest/download/codex-tab-0.0.2.vsix)

Then reload `code-server`, open the Command Palette, run `Codex Autocomplete: Sign In`, finish the browser flow, paste the callback URL, and run `Codex Autocomplete: Check Setup`.

## What It Does

- Inline ghost text completions inside `code-server`
- Server-side execution with `extensionKind: ["workspace"]`
- Direct `https://chatgpt.com/backend-api/codex/responses` calls
- Hard-locked model configuration: `gpt-5.4-mini` with `low` reasoning effort
- Extension-owned OAuth PKCE sign-in stored in VS Code secret storage
- No thread-based `codex app-server` generation flow

## Requirements

- `code-server`
- Access to `gpt-5.4-mini`
- Outbound network access from the `code-server` host to OpenAI endpoints

## How It Works

`Codex Tab` runs on the same machine as your `code-server` extension host. It starts a Codex OAuth PKCE sign-in flow from the command palette, stores refreshable credentials in VS Code secret storage, runs a live setup probe against `gpt-5.4-mini`, and requests streamed plain-text completions from the Codex responses backend. Nothing runs in the browser beyond the normal `code-server` UI and the login redirect.

## Commands

- `Codex Autocomplete: Sign In`
- `Codex Autocomplete: Sign Out`
- `Codex Autocomplete: Check Setup`
- `Codex Autocomplete: Reload Auth`
- `Codex Autocomplete: Open Logs`
- `Codex Autocomplete: Accept Next Word`

## Settings

- `codexAutocomplete.enabled`
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
code-server --install-extension ./codex-tab-0.0.2.vsix
```

## License

Apache-2.0
