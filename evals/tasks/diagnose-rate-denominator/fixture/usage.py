def cache_hit_rate(events):
    """Share of the prompt served from cache, as a percentage.

    Each event reports `input` (tokens sent fresh) and `cache_read`
    (tokens served from cache). They are disjoint counts.
    """
    fresh = sum(e['input'] for e in events)
    cached = sum(e['cache_read'] for e in events)
    if fresh == 0:
        return 0.0
    return 100.0 * cached / fresh
