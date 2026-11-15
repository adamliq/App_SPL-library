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
| `.github/workflows/build.yml` | Runs the build on every push to `main` and every pull request |

## Building the package

```sh
scripts/build.sh            # writes dist/spl-library_<version>.spl
```

The script fails if a JavaScript file has a syntax error, an XML file is
malformed, a hidden file (such as `.DS_Store`) is present, or `app.conf` lacks
an `X.Y.Z` version. The package name comes from that version, so bump
`version` in `spl_library/default/app.conf` when releasing.

Builds are reproducible: the same commit always produces a byte-identical
package.

On GitHub, each run of the **Build app package** workflow attaches the package
as a downloadable artifact named `spl-library`.

## Installing

In Splunk Web: **Apps > Manage Apps > Install app from file**, then choose the
`.spl`. From the command line:

```sh
$SPLUNK_HOME/bin/splunk install app spl-library_<version>.spl
$SPLUNK_HOME/bin/splunk restart
```
