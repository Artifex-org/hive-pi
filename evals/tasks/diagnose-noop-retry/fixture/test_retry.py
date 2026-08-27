from retry import run_with_retries
import unittest


class Tests(unittest.TestCase):
    def test_succeeds_first_try(self):
        assert run_with_retries(lambda: (True, True)) == ('done', 1)


    def test_stops_on_a_successful_noop(self):
        assert run_with_retries(lambda: (True, False)) == ('no-change', 1)


    def test_retries_a_real_failure(self):
        state = {'n': 0}

        def attempt():
            state['n'] += 1
            return (state['n'] >= 3, True)

        assert run_with_retries(attempt) == ('done', 3)

