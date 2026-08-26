#!/usr/bin/env bash
echo 'compiling module a... ok'
echo 'compiling module b... ok'
echo 'linking...'
echo 'error: undefined reference to `missing_symbol`' >&2
exit 1
