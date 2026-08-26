from collect import collect
import unittest


class Tests(unittest.TestCase):
    def test_first_call(self):
        assert collect('a') == ['a']


    def test_second_call_is_independent(self):
        collect('a')
        assert collect('b') == ['b']


    def test_supplied_list_is_used(self):
        target = ['x']
        assert collect('y', target) == ['x', 'y']

