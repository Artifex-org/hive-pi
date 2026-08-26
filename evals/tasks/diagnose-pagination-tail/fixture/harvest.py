PAGE_SIZE = 10


def fetch_page(records, page):
    start = (page - 1) * PAGE_SIZE
    return records[start:start + PAGE_SIZE]


def harvest(records):
    """Return every record, walking pages until they run out."""
    out = []
    page = 1
    while len(out) + PAGE_SIZE <= len(records):
        out.extend(fetch_page(records, page))
        page += 1
    return out
