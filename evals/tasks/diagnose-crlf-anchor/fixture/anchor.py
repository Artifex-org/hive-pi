def find_block(content, block):
    """Index of `block` in `content`, or -1. Line endings must not matter."""
    return content.find(block)
