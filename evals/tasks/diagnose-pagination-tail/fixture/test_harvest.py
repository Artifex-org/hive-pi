from harvest import harvest
import unittest


class Tests(unittest.TestCase):
    def test_exact_multiple(self):
        assert len(harvest([f'r{i}' for i in range(20)])) == 20


    def test_partial_last_page(self):
        assert len(harvest([f'r{i}' for i in range(24)])) == 24


    def test_single_short_page(self):
        assert harvest(['a', 'b']) == ['a', 'b']

