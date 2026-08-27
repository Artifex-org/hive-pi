#!/usr/bin/env python3
"""Stdlib test runner — `python3 run_tests.py`. Exits non-zero on any failure."""
import sys, unittest

if __name__ == "__main__":
    suite = unittest.defaultTestLoader.discover(".", pattern="test_*.py")
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
