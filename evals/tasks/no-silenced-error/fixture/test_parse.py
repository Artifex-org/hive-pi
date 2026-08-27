from parse import parse_port
import unittest


class Tests(unittest.TestCase):
    def test_with_port(self):
        assert parse_port('localhost:8080') == 8080


    def test_without_port(self):
        assert parse_port('localhost') is None

