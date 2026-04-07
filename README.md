# Codex Tab

`code-server`-only ghost text autocomplete for Codex-backed accounts.

## Quick Install

- Latest release page: [GitHub Releases](https://github.com/smturtle2/codex-tab/releases/latest)
- Direct VSIX download: [codex-tab-0.0.1.vsix](https://github.com/smturtle2/codex-tab/releases/latest/download/codex-tab-0.0.1.vsix)

Install into `code-server` after downloading:

```bash
code-server --install-extension ./codex-tab-0.0.1.vsix
```

## Requirements

- `code-server`
- A file-backed Codex login at `~/.codex/auth.json`
- A ChatGPT-backed Codex account that can access `gpt-5.4-mini`

## Development

```bash
npm install
npm run build
npm test
npm run package:vsix
```

Install the generated local `.vsix` into `code-server` with:

```bash
code-server --install-extension ./codex-tab-0.0.1.vsix
```
