# pi-repos

Pi extension for inspecting GitHub repositories without cloning them into the current project.
It adds repository discovery, directory listing, file reads, glob file search, and content grep tools.

## Installation

From GitHub after the repository is published:

```bash
pi install git:github.com/liamvinberg/pi-repos
```

For local development:

```bash
pi -e /absolute/path/to/pi-repos
# or
pi install /absolute/path/to/pi-repos
```

## Tools

| Tool | Purpose |
| --- | --- |
| `repo_find` | Search GitHub repositories by query. |
| `repo_list` | List a directory in a remote GitHub repository. |
| `repo_read` | Read a file from a remote repository, using cached archives when possible. |
| `repo_find_files` | Find files in a remote repository by glob. |
| `repo_grep` | Search file contents in a remote repository with archive + ripgrep acceleration when available. |

## Examples

```text
Find the React repository and inspect its package layout.
```

```text
Use repo_grep to search vercel/next.js for createIncrementalCache.
```

```text
Read README.md from github.com/earendil-works/pi-mono.
```

## Configuration

The extension reads these optional environment variables:

| Variable | Description |
| --- | --- |
| `GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_PAT`, `GITHUB_PERSONAL_ACCESS_TOKEN` | Token for higher GitHub API limits. If absent, the extension tries `gh auth token`. |
| `PI_REPOS_CACHE_DIR` | Cache root for downloaded repository archives. Defaults to `~/.cache/pi-repos`. |
| `PI_REPOS_REF_REFRESH_MS` | How long cached ref-to-commit lookups are considered fresh. Defaults to 5 minutes. |

## Development

```bash
npm install
npm run check
pi -e .
```

## Notes

- The package uses Pi's package manifest under the `pi` key and exposes `./src/index.ts` as the extension entry point.
- Runtime GitHub archive caches are kept outside the package directory.
- Extensions run with full local permissions; review third-party Pi packages before installing them.
