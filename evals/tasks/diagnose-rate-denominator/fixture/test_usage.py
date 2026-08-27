from usage import cache_hit_rate
import unittest


class Tests(unittest.TestCase):
    def test_no_cache_is_zero(self):
        assert cache_hit_rate([{'input': 100, 'cache_read': 0}]) == 0.0


    def test_half_cached(self):
        assert cache_hit_rate([{'input': 50, 'cache_read': 50}]) == 50.0


    def test_never_exceeds_one_hundred(self):
        for fresh, cached in [(0, 0), (1, 9999), (10, 90), (12345, 6789)]:
            rate = cache_hit_rate([{'input': fresh, 'cache_read': cached}])
            assert 0.0 <= rate <= 100.0, (fresh, cached, rate)

