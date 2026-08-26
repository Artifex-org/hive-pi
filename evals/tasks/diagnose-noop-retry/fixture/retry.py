def run_with_retries(attempt, max_attempts=3):
    """Call attempt() until it reports a change, or the budget runs out.

    attempt() returns (ok, changed). A call that succeeds but changed
    nothing must NOT consume the whole budget — it cannot succeed by
    being repeated, so stop and report it.
    """
    calls = 0
    for _ in range(max_attempts):
        calls += 1
        ok, changed = attempt()
        if ok and changed:
            return 'done', calls
    return 'exhausted', calls
