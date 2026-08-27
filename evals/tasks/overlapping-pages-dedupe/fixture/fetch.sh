#!/usr/bin/env bash
# 5 pages of 20, but each page repeats the last 5 of the previous page.
page=1
while [ $# -gt 0 ]; do case "$1" in --page) page="$2"; shift 2;; *) shift;; esac; done
[ "$page" -gt 5 ] && exit 0
start=$(( (page - 1) * 15 + 1 ))
for i in $(seq $start $((start + 19))); do [ $i -le 80 ] && echo "rec-$i"; done
