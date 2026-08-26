from anchor import find_block
import unittest


class Tests(unittest.TestCase):
    def test_plain(self):
        assert find_block('alpha\nbeta\ngamma\n', 'beta\n') >= 0


    def test_crlf_content(self):
        assert find_block('alpha\r\nbeta\r\ngamma\r\n', 'beta\n') >= 0


    def test_absent_is_minus_one(self):
        assert find_block('alpha\nbeta\n', 'delta\n') == -1

