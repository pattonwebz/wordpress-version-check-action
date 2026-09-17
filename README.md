# WordPress version check

A composite GitHub Action that keeps a plugin readme's `Tested up to:` line honest.

When the readme is behind the current WordPress release, it opens a tracking issue. While the gap
persists it keeps that issue's title and body updated (without touching it when nothing changed), and
once the readme catches up it comments on the issue and closes it.

**No labels.** The tracking issue is identified by a hidden marker in its body — nothing to create,
nothing to curate, nothing to lose during a label cleanup. The default marker is
`<!-- wp-version-check:tested-up-to -->` and it is configurable.

- Zero dependencies: one ES module, run by the runner's own `node`. No build step, no bundled `dist/`,
  no declared Node runtime for GitHub to deprecate.
- Reads the readme from the repository's **default branch**, not the branch that triggered the run.
- `dry-run: true` reports what it would do and writes nothing.

## Usage

```yaml
name: "WordPress version checker"

on:
  push:
    branches: [develop, main]
  schedule:
    - cron: '0 0 * * *'
  workflow_dispatch:

permissions:
  contents: read
  issues: write

concurrency:
  group: wp-version-check
  cancel-in-progress: false

jobs:
  wordpress-version-checker:
    runs-on: ubuntu-latest
    steps:
      - uses: pattonwebz/wordpress-version-check-action@<full-commit-sha> # v1.0.0
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

Pin a full commit SHA (with the version in a trailing comment) rather than a moving tag, so nothing
you didn't review can change your CI behaviour.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `github-token` | workflow token | Token with `issues: write`. The default is fine in normal use. |
| `readme` | `readme.txt` | Readme path, or several to try in order (newline or comma separated), e.g. `readme.txt, src/readme.md`. |
| `channel` | `rc` | Which WordPress release to compare against: `stable`, `rc` or `beta`. |
| `assignees` | *(none)* | Comma-separated usernames to assign the issue to, on creation only. |
| `marker` | `<!-- wp-version-check:tested-up-to -->` | Hidden marker written into the issue body. Change it to transfer ownership to a different issue. |
| `dry-run` | `false` | Log the decision and perform no writes. |

## Outputs

| Output | Description |
| --- | --- |
| `action` | `none`, `created`, `updated`, `unchanged` or `closed`. In dry-run mode this is the action it *would* have taken. |
| `issue-number` | The issue number touched, empty when none. |

## Behaviour

1. Fetch the latest WordPress versions from `api.wordpress.org` and normalise them to `major.minor`
   (so `7.1.1-RC1` counts as `7.1`).
2. Read the first readme that exists from the candidate list, on the default branch, and parse
   `Tested up to:`.
3. If the readme is behind: find the open issue whose body contains the marker (read through the
   GraphQL issues connection — see below). Create it if missing, update it if the title or body has
   drifted, and do nothing at all if it already matches.
4. If the readme is current: if a marked issue is open, comment that the versions now match and close
   it. Otherwise do nothing.

Precedence is stable → rc → beta, filtered by `channel`: with the default `rc`, a readme that is level
with stable but behind an approaching release candidate gets an "upcoming version" issue.

### Why the lookup uses GraphQL

GitHub's REST `GET /repos/{owner}/{repo}/issues` **list** endpoint is eventually consistent — measured
at up to ~5 seconds stale in both directions. Within that window, a second run could re-comment on a
just-closed issue, or open a duplicate tracking issue. The GraphQL `issues` connection reflects state
immediately, so the lookup goes through it; single-issue reads and all writes stay on REST, where they
are consistent. Add a `concurrency` group to the calling workflow (see the usage example) so two runs
queue rather than race — belt and braces, since the push and cron triggers can otherwise land together.

Errors fail the run loudly (`::error::` + non-zero exit) rather than silently doing nothing —
including a readme with no `Tested up to:` line, and a repo with 100+ open issues (where this action
refuses to guess which issue it owns rather than risk opening a duplicate).

## Testing it safely

Use `workflow_dispatch` with a boolean input, so a manual run never writes:

```yaml
on:
  workflow_dispatch:
    inputs:
      dry_run:
        description: 'Log what would happen without writing anything'
        type: boolean
        default: true

# ...
      - uses: pattonwebz/wordpress-version-check-action@<sha>
        with:
          dry-run: ${{ github.event_name == 'workflow_dispatch' && inputs.dry_run || 'false' }}
```

The run log then contains a decision line, e.g.:

```
::notice::readme.txt on develop: "Tested up to" is 7.1; WordPress stable 7.1, rc 7.2. (dry run)
::notice::Dry run — would open "The plugin hasn't been tested with an upcoming version of WordPress" (tested 7.1 < 7.2).
```

Or run it straight from a checkout, which needs no workflow at all:

```bash
GITHUB_TOKEN=$(gh auth token) GITHUB_REPOSITORY=owner/repo INPUT_DRY_RUN=true node check.mjs
```

## Development

```bash
node --test test/check.test.mjs
```

The suite stubs the GitHub API and the WordPress version endpoint, so it runs offline and in
milliseconds. `run(env, log, deps)` accepts `{ api, versions }` overrides for that purpose.

## Why not the label-based action?

The action this replaces (`skaut/wordpress-version-checker`) hard-codes a `wpvc` label in both its
issue lookup and its issue creation, in every released version, with no input to change it. That
means:

- the label has to exist in the repo first (creating an issue with a missing label returns
  `422 Validation Failed`), and deleting it during a cleanup silently breaks the check;
- the label's name is dictated by a third-party bundle, so it can't be folded into a house label
  taxonomy;
- releases are infrequent (last one Feb 2025) and its declared Node runtime has been out of date for
  a while — recent runs log `Node.js 20 is deprecated … being forced to run on Node.js 24`.

This action gets the same outcome with no labels, no runtime declaration, and no dependency beyond
`node` and `fetch`.

## Licence

MIT.
