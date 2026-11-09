#!/bin/sh
set -eu
# This runs before the official entrypoint starts any server or native consumer.
sh /docker-entrypoint-initdb.d/00-verify-schema.sh
exec /entrypoint.sh "$@"
