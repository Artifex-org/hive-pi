def dedupe(rows):
    """Rows are dicts with session, seq and body. A row is unique per
    (session, seq) — the same seq recurs across different sessions."""
    seen = set()
    out = []
    for row in rows:
        key = row['seq']
        if key in seen:
            continue
        seen.add(key)
        out.append(row)
    return out
