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
  Runs on the <code>code-server</code> host, reads your existing <code>~/.codex/auth.json</code>, and sends direct Codex <code>/responses</code> requests for inline completions.
</p>

## Quick Start

Install the latest release into `code-server`:

```bash
tmpfile="$(mktemp -t codex-tab-XXXXXX.vsix)" && \
curl -fL "https://github.com/smturtle2/codex-tab/releases/latest/download/codex-tab-0.0.1.vsix" -o "$tmpfile" && \
code-server --install-extension "$tmpfile" && \
rm -f "$tmpfile"
```

Release links:

- Latest release: [github.com/smturtle2/codex-tab/releases/latest](https://github.com/smturtle2/codex-tab/releases/latest)
- Direct VSIX asset: [codex-tab-0.0.1.vsix](https://github.com/smturtle2/codex-tab/releases/latest/download/codex-tab-0.0.1.vsix)

Then reload `code-server`, open the Command Palette, and run `Codex Autocomplete: Check Setup`.

## What It Does

- Inline ghost text completions inside `code-server`
- Server-side execution with `extensionKind: ["workspace"]`
- Direct `https://chatgpt.com/backend-api/codex/responses` calls
- Hard-locked model configuration: `gpt-5.4-mini` with `low` reasoning effort
- Existing Codex login reuse through `~/.codex/auth.json`
- No thread-based `codex app-server` generation flow

## Requirements

- `code-server`
- A readable file-backed Codex login at `~/.codex/auth.json`
- Access to `gpt-5.4-mini`
- Outbound network access from the `code-server` host to OpenAI endpoints

## How It Works

`Codex Tab` runs on the same machine as your `code-server` extension host. It reads your existing Codex auth file, refreshes tokens when needed, validates model availability, and requests structured completions from the Codex responses backend. Nothing runs in the browser beyond the normal `code-server` UI.

## Commands

- `Codex Autocomplete: Check Setup`
- `Codex Autocomplete: Reload Auth`
- `Codex Autocomplete: Open Logs`
- `Codex Autocomplete: Accept Next Word`

## Settings

- `codexAutocomplete.enabled`
- `codexAutocomplete.debounceMs`
- `codexAutocomplete.maxPrefixChars`
- `codexAutocomplete.maxSuffixChars`
- `codexAutocomplete.authFilePath`
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
code-server --install-extension ./codex-tab-0.0.1.vsix
```

## License

Apache-2.0
