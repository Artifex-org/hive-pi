from dedupe import dedupe
import unittest


def row(session, seq):
    return {'session': session, 'seq': seq, 'body': f'{session}-{seq}'}


class Tests(unittest.TestCase):
    def test_drops_true_duplicates(self):
        assert len(dedupe([row('a', 1), row('a', 1), row('a', 2)])) == 2

    def test_keeps_same_seq_from_different_sessions(self):
        assert len(dedupe([row('a', 1), row('b', 1), row('c', 1)])) == 3

    def test_preserves_order(self):
        assert [r['body'] for r in dedupe([row('b', 2), row('a', 2)])] == ['b-2', 'a-2']
