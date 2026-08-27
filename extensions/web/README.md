# web — search + fetch, in-house (HIV-1224)

Replaces `pi-web-access` (17k LOC) with ~500. Two tools:

- **`web_search`** — Exa (`EXA_API_KEY` from `~/.secrets`), the provider the
  package's own `auto` mode preferred. Defensive response parsing; snippets
  capped at 1.5k chars.
- **`fetch_content`** — readable markdown from HTML (Readability article
  isolation with whole-page fallback → in-house DOM walker, markdown.ts), PDF (unpdf), and
  text/JSON. Truncation states the cut and teaches narrowing.

Security posture (the part of the package worth keeping, rebuilt in
`ssrf.ts`): http(s) only; private/reserved IPv4+IPv6 refused including
**CGNAT 100.64/10 (the Tailscale range)**; internal hostname suffixes
(`.local`, `.internal`, `.ts.net`) refused; hostnames are DNS-resolved and
vetted before fetch; redirects are followed manually with **every hop
re-vetted** (a public URL 302ing internal is the practical bypass); 10 MB
body cap, 20 s timeout.

Deliberately dropped from the package: the 112 KB curator page + local HTTP
server, the **Chrome cookie-jar reader**, 12 of 13 search providers,
video/YouTube/RSC extraction, both global shortcuts, and the `web-activity`
widget (the deck owns that band now — HIV-1219; ambient web activity would
return as a deck section signal, not a widget key).
