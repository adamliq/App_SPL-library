# App_SPL-library

Source for **SPL Library**, a Splunk app for storing, searching and sharing
SPL queries. See [`spl_library/README.md`](spl_library/README.md) for what the
app does; that file ships inside the package.

## Layout

| Path | What it is |
| --- | --- |
| `spl_library/` | The app itself, laid out as Splunk expects under `$SPLUNK_HOME/etc/apps/` |
| `spl_library/appserver/static/` | The dashboard's JavaScript and CSS |
| `spl_library/default/` | `app.conf` (holds the version), KV Store collection, lookup, view and nav |
| `scripts/build.sh` | Checks the source and builds the installable `.spl` package |
| `scripts/appinspect.sh` | Runs Splunk AppInspect's Splunk Cloud checks on a built package |
| `test/` | Local Splunk in Docker plus an end-to-end browser test |
| `.github/workflows/build.yml` | Builds and inspects the package on every push to `main` and every pull request |

## Building the package

```sh
scripts/build.sh            # writes dist/spl-library_<version>.spl
```

The script fails if a JavaScript file has a syntax error, an XML file is
malformed, a hidden file (such as `.DS_Store`) is present, or `app.conf`
lacks an `X.Y.Z` version. The package name comes from that version, so when
releasing, bump `version` in **both** the `[id]` and `[launcher]` stanzas of
`spl_library/default/app.conf`; the build fails if they differ.

Builds are reproducible: the same commit always produces a byte-identical
package.

## Checking Splunk Cloud compatibility

```sh
python3 -m venv .venv && .venv/bin/pip install splunk-appinspect==4.4.0
PATH=.venv/bin:$PATH scripts/appinspect.sh dist/spl-library_<version>.spl
```

This runs AppInspect with the `cloud`, `private_victoria` and
`private_classic` tags, the check sets Splunk Cloud vetting uses. It fails on
any failure or error, prints warnings without failing, and writes JSON reports
to `dist/appinspect/`. Install AppInspect in a virtualenv: with some system
Pythons, one of its dependencies (`painter`) fails to build otherwise.

## Trying it in a local Splunk

Needs Docker and Node.js.

```sh
docker compose -f test/docker-compose.yml up -d --wait   # Splunk with the app mounted
# browse to http://localhost:8000, log in as admin / Changeme123!

cd test && npm install && npx playwright install chromium
npm test                                                  # end-to-end checks, about a minute
docker compose -f test/docker-compose.yml down -v         # stop and discard the container
```

The container mounts `spl_library/` directly. Splunk caches the app's
JavaScript and CSS, so after editing them open
http://localhost:8000/en-US/_bump and click **Bump version**, then refresh
(`npm test` does this for you). Changes to `.conf` files need a Splunk restart
(`docker compose -f test/docker-compose.yml restart`). The admin password is a
throwaway default for local use; set `SPLUNK_PASSWORD` to change it, for both
the container and the test.

`npm test` logs in, then checks search and its keyboard shortcuts, card
expand/collapse, the theme toggle, the narrow-panel layout, the add-query form,
SPL and search-match highlighting, tag filtering, line wrapping, the sticky
top bar and sidebar, the compact view, the discard prompt, shareable links
(including following a copied link in a new tab), stars, usage counts and
sorting, loading placeholders and retries (by intercepting the app's requests),
and category management, including that a temporary non-admin user cannot see
Manage and that Splunk refuses their direct writes. Everything runs on temporary
queries, categories and users that are removed at the end, so the test leaves
the library as it found it. Screenshots are saved in
`test/screenshots/`.

## Installing

In Splunk Web: **Apps > Manage Apps > Install app from file**, then choose the
`.spl`. From the command line:

```sh
$SPLUNK_HOME/bin/splunk install app spl-library_<version>.spl
$SPLUNK_HOME/bin/splunk restart
```
