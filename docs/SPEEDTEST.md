# Speedtest edition

This fork adds a node speed test panel to Clash Verge Rev. Open it from a proxy
group's speedometer button or the Tests page. Filter nodes, select the nodes to
test, and choose latency, download, or both. Click a result column to reverse its
sort order. A separate test of one metric preserves the other metric's result.
Failed and untested measurements sort last.

Results are saved locally per subscription and survive closing the dialog or
restarting the app. A new measurement replaces only that node's tested metric;
stopping a run retains earlier results for nodes that have not completed. Hover
over a result to see when it was measured. Node cards show the saved download
speed beside latency. Click the download icon or speed to test that node alone
(up to 5 seconds / 20 MiB); click again to stop. The existing latency click still
tests only latency and preserves the download result.

In the dialog, choose **Apply to group** and click **Use node**. The choice is
applied to the running core and saved with the same selection persistence used
by the proxy page. Nested selectable groups are updated from the leaf upward.
This changes the chosen group's route; other rule groups keep their selections.

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
workflow. The speedtest implementation lives in separate modules. The entry
buttons, command registration and updater guards are reapplied to the new
upstream files by `scripts/speedtest-overlay.mjs`. Each insertion must find one
unambiguous anchor; existing fork edits must exactly match the recorded overlay
before they can be replaced. The native latency hook stays unchanged; a separate
speedtest hook adds saved measurements to node cards.

This avoids nearby import and insertion conflicts without discarding upstream
changes. It is not a plugin API: changes to an anchor, node-card layout, or a
dependency can still require adaptation. Other files use ordinary Git merging.
A conflict fails with a list of conflicting files in the run summary.
The candidate retains this fork's workflow files because `GITHUB_TOKEN` cannot
push workflow changes. The summary lists upstream CI differences for separate
review; application code and build dependencies still follow the stable release.
A build failure leaves the candidate available for repair. Rerunning upstream
update reuses the candidate and reruns its checks and build. Neither case changes
the working `speedtest` branch or installs anything on your computer.

After all checks and the Windows build succeed, the workflow advances `speedtest`
to that exact tested commit, retaining upstream merge history. It refuses to
advance if either branch changed during the build. The installer remains an
artifact of the update run; download and install it manually. Compatible releases
therefore require no editing, merging, or manual build dispatch.

## Validation

The build runs a result-ordering regression test and an integration check with the
real mihomo executable and two local HTTP proxies. The integration check verifies
that selecting a different node changes the download path, that provider nodes
are selectable, and that an unknown node is rejected. This catches routing errors
that a successful UI build cannot detect. It does not certify every proxy protocol
or replace checking a candidate with your own subscriptions.
