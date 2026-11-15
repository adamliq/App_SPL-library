# SPL Library v3.0 — Cloud Ready

A modern library for storing, searching, and managing your Splunk queries.

## Cloud compatibility

Passes Splunk AppInspect 4.4.0 with the cloud, private_victoria and
private_classic check sets (0 failures; every build is checked):
- No custom REST handlers, no restmap.conf, no web.conf changes
- No binaries or Python in bin/
- No inline JavaScript in views — all code lives in appserver/static/
- No external CDN resources; only Splunk-provided libraries (jQuery, splunkjs)
- Storage is the standard App Key Value Store (KV Store)

## Features

- Card-based interface with light and dark themes (toggle in the top bar)
- Layout adapts to the panel width; categories become a chip strip on narrow panels
- Full-text search across titles, descriptions, tags, and SPL, with matches
  highlighted on the cards
- Category filters with live counts (Security, Network, Application,
  Database, Performance, Other); click any tag on a card to filter by that tag
- The top bar and category list stay in view while scrolling
- Each card previews its SPL (the matching line while searching); expand it to
  view the full query with syntax highlighting (long lines wrap; turn off
  "Wrap lines" to scroll them instead, remembered per browser)
- Star queries to collect them under Starred; stars are saved per user
- Sort by newest, title, or most used (each Copy SPL and Open in Search click
  counts as a use)
- Shareable links: the address bar always reflects the current search, category,
  sort and open query, and "Copy link" on a card copies a link that opens it
- Keyboard friendly: press / to search, Esc to clear, Enter/Space to expand a card,
  Ctrl/Cmd+Enter to save in the query form
- Copy SPL to clipboard with one click
- "Open in Search" — runs the saved query directly in the Search app
- Add / edit / delete queries via a modal form with tag management; Cancel
  asks before discarding unsaved changes
- Auto-seeds example queries on first load (into an empty collection only)
- Records author and created/updated dates per query

## Storage

Queries live in the spl_library_queries KV Store collection. Stars are kept
in spl_library_favorites (one record per user) and use counts in
spl_library_usage (one record per query). The queries collection is also exposed
as the spl_library_lookup lookup so you can use the library in SPL:

    | inputlookup spl_library_lookup
    | inputlookup spl_library_lookup | search category=Security

## Installation

Splunk Cloud: install via Apps > Manage Apps > Install app from file,
or through self-service app install / Admin Config Service (ACS),
depending on your stack's policy. Private apps must pass AppInspect;
this app is structured for the cloud check set.

Splunk Enterprise: extract to $SPLUNK_HOME/etc/apps/ or install the
.tar.gz from Manage Apps, then restart.

## Permissions

All users can read and add queries. To restrict who can write, edit the
[collections] stanza in metadata/default.meta.

The app's views, nav and lookup can be changed by admin, power and sc_admin
(the Splunk Cloud administrator role).
