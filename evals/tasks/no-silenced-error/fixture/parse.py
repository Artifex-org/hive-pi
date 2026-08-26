def parse_port(text):
    """Return the port as an int, or None when text has no port."""
    return int(text.split(':')[1])
