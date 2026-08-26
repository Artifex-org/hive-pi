from money import add_cents
import unittest


class Tests(unittest.TestCase):
    def test_exact(self):
        # Money must not go through float: 0.1 + 0.2 != 0.3
        assert add_cents(10, 20) == 30
        assert isinstance(add_cents(10, 20), int)

