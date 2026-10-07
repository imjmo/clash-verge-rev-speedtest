# Speedtest edition

This fork adds a node speed test panel to Clash Verge Rev. Open it from a proxy
group's speedometer button or the Tests page. Filter nodes, select the nodes to
test, and choose latency, download, or both. Click a result column to reverse its
sort order. A separate test of one metric preserves the other metric's result.
Failed and untested measurements sort last.

Downloads use an isolated mihomo process and an authenticated loopback listener
bound to a dedicated selector. The main application's selected proxy and routing
rules are not changed. The selector includes subscription provider nodes. Both
tests run sequentially, with latency first; downloads run one node at a time.
The displayed rate is MiB/s, measured over the request including connection time.
The data limit is approximate network consumption: protocol overhead and buffered
data can exceed the reported payload bytes. Stop cancels the current request and
terminates the isolated core. Temporary configuration and caches are removed after
the child exits. No subscription data is committed to this repository.

## Build

Use the upstream development prerequisites, then run:

```sh
pnpm install --frozen-lockfile
pnpm prebuild
pnpm build:speedtest
```

`build:speedtest` disables the upstream binary updater, including cached update
installation. Install subsequent custom builds manually. Using the ordinary
upstream build command does not apply this protection. These installers reuse
the normal Clash Verge application identity and data directory.

## GitHub Actions

Set this fork's default branch to `speedtest`. Enable **Speedtest Windows build**
and **Speedtest upstream update**. Keep inherited upstream publishing, updater,
notification and other scheduled workflows disabled in this personal fork.
Use the update workflow instead of GitHub's generic **Sync fork** button for this
branch: the parent repository's default development branch is not a stable release.

The Windows workflow accepts manual runs and builds pushes to `speedtest` and
`speedtest-update/**`. Download the ZIP artifact from its completed run, extract
it, and run the Windows x64 installer. Artifacts expire after 90 days; keep a local
copy. No upstream signing secrets are required. The installer is not signed with
the upstream maintainers' identity.

The upstream update workflow checks the latest stable release daily at 03:23 UTC
(11:23 Hong Kong time), or when run manually. GitHub schedules are best effort and
may be delayed; scheduled workflows in inactive public repositories may be
disabled by GitHub. If necessary, re-enable the workflow or run it manually.

It merges the release into a candidate branch, then calls the Windows build
workflow explicitly: pushes made with `GITHUB_TOKEN` do not trigger another push
workflow. A conflict fails with a list of conflicting files in the run summary.
A build failure leaves the candidate available for repair. Neither case changes
the working `speedtest` branch or installs anything on your computer.

After checking a candidate installer, merge its branch into `speedtest` using a
normal merge (not a squash or rebase), preserving the upstream merge history.
The next update will retain these changes. No manual reapplication of the feature
is needed when upstream is compatible.

## Validation

The build runs a result-ordering regression test and an integration check with the
real mihomo executable and two local HTTP proxies. The integration check verifies
that selecting a different node changes the download path, that provider nodes
are selectable, and that an unknown node is rejected. This catches routing errors
that a successful UI build cannot detect. It does not certify every proxy protocol
or replace checking a candidate with your own subscriptions.
