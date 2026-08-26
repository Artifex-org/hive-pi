#!/usr/bin/env bash
# Paginated: 30 records per page, 74 records total.
page=1
while [ $# -gt 0 ]; do case "$1" in --page) page="$2"; shift 2;; *) shift;; esac; done
start=$(( (page - 1) * 30 + 1 ))
end=$(( start + 29 ))
[ $start -gt 74 ] && exit 0
[ $end -gt 74 ] && end=74
for i in $(seq $start $end); do echo "record-$i"; done
