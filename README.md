# Suvio plugin release workflow

A shared GitHub Actions workflow around the **existing published Suvio SDK
publisher**. This repository contains CI configuration, one small JavaScript
helper for candidate handoff, and a standalone Gradle dependency bootstrap.
It contains no plugin source, SDK source, credentials or deployment configuration.

## Caller configuration

Use the maintained `v1` branch. Compatible CI updates roll out centrally without
editing callers. Each run resolves its exact workflow commit from GitHub's run
metadata and uses that commit for both the build and submission tooling.
Keep runner labels, Store configuration and publisher credentials in the caller.

```yaml
name: Release plugins
on:
  pull_request:
  push:
    tags: ["v[0-9]*"]
  workflow_dispatch:
    inputs:
      tag:
        type: string
        required: true
      submit-to-store:
        type: boolean
        default: false
permissions:
  contents: read
jobs:
  release:
    if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository
    uses: ShinudaCommunity/plugin-workflows/.github/workflows/release.yml@v1
    permissions:
      actions: read
      contents: write
    with:
      runner: ${{ vars.PLUGIN_RELEASE_RUNNER }}
      tag: ${{ github.event_name == 'push' && github.ref_name || inputs.tag || '' }}
      plugins: ${{ github.event_name == 'push' && 'tag' || 'all' }}
      submit-to-store: ${{ github.event_name == 'push' || inputs.submit-to-store == true }}
      packages: '[{"name":"example","file":"build/distributions/example.suvio","tagPrefix":"v"}]'
    secrets:
      SUVIO_PUBLISH_TOKEN: ${{ secrets.SUVIO_PUBLISH_TOKEN }}
      SUVIO_SIGNING_PRIVATE_KEY: ${{ secrets.SUVIO_SIGNING_PRIVATE_KEY }}
```

`runner` is a JSON `runs-on` object for an existing Ubuntu/Debian Linux x64 pool.
The workflow installs the public Wasmtime C API with a pinned checksum. It does
not fall back to a different runner. Private self-hosted pools never run fork PRs.
`actions: read` allows reading the resolved workflow revision for this run;
there is no separate revision input to keep synchronized.

The default Gradle tasks are `["check", "packageSuvioPlugin"]`. Override
`gradle-tasks` with a JSON array for a multi-project build. Package names, file
paths and tag prefixes must be unique. IDs and versions come from the built V8
archives; do not duplicate them in workflow inputs.

Repositories requiring a patched runtime may set `prepare-script` to a checked-in
Bash script. It replaces the default Linux prerequisite/Wasmtime installation and
runs from the source checkout after Java and Node setup. Use `GITHUB_ENV` for public
runtime paths needed by the following Gradle step. An optional `verify-script`
runs after Gradle and before candidate collection, for example to require executed
WASI tests without skips. Both scripts run in checks/build jobs without publisher
credentials; Gradle checks and package validation still run normally.

## One package or several

List multiple packages in `packages` and use `plugins: all` (default), `tag`
(only the package matching the pushed tag), or a comma-separated selection.
Each package may have an independent version.
Assign tag prefixes such as `v` and `second-v`; the annotated release tag must
match the manifest version of one selected package. The tag must point to a
commit already accepted into the caller's default branch. Dispatch releases
from that branch. PR checks do not require tags.

Checks build all configured packages. Releases retain their exact bytes, source
commit, sizes and SHA-256 checksums as **draft release assets in the caller's
repository**. No Actions artifact storage is needed. Selected packages submit
in independent jobs, at most two at a time, without cancelling siblings after
one fails. Each plugin/version has its own submission concurrency lock.

Rerunning a failed submit job reuses the verified asset. Rerunning the whole
workflow creates new candidates for that run attempt. Existing published GitHub
releases are never replaced. The SDK publisher handles idempotent Store retries;
different package bytes under an existing version require a new version.

## Publisher setup

In the caller's protected `suvio-plugin-publisher` environment configure:

| Kind | Name |
| --- | --- |
| Secret | `SUVIO_PUBLISH_TOKEN` |
| Secret | `SUVIO_SIGNING_PRIVATE_KEY` |
| Variable | `SUVIO_STORE_URL` |
| Variable | `SUVIO_SIGNING_KEY_ID` |
| Optional variable | `SUVIO_CONSOLE_URL` |

Register the namespace and signing public key, accept the publisher terms, and
create a CI token scoped to the intended plugins outside the agent. Enter real
secret values manually. Use an ephemeral runner and protected environment rules.

Publisher credentials reach only the final Java process in the submit job.
Neither plugin Gradle builds nor publisher dependency resolution receives them.
The publisher is the released `cc.suviomedia:plugin-publisher:1.0.0-rc.56`; it
validates and signs the archive using the SDK and submits it for Store review.
The helper only checks identity and exact candidate transfer, not the SDK's
signature or package rules.

CI reports `PENDING_REVIEW` or `APPROVED` and an optional developer-console link.
Store review remains authoritative; draft candidates are not approved Store
artifacts. No separate status dashboard or automatic GitHub release finalization
is created.

## Maintenance

Develop and test changes on `main`, then advance the `v1` branch to the tested
commit. Keep `v1` compatible with existing callers; use a new major branch such
as `v2` for incompatible inputs or behavior. Do not create a tag named `v1`,
because GitHub would prefer it over the branch.

All new runs using `@v1` receive compatible updates without per-repository PRs.
Runs already started keep their resolved workflow commit, and a retried submit
uses the same tooling as its original build. Callers may still use a full commit
SHA in `uses` when they explicitly need a frozen version; no second pin is needed.
An SDK version bump is not required for CI changes.

Local checks use Node 24+, a JDK (`jar`) and `unzip`:

```sh
node --test tools/*.test.mjs
actionlint .github/workflows/release.yml
```
