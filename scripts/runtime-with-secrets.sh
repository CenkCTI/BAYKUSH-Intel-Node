#!/bin/sh
set -eu

load_secret() {
  name=$1
  file_name="${name}_FILE"
  eval "direct=\${$name-}"
  eval "file=\${$file_name-}"

  if [ -n "${direct:-}" ] && [ -n "${file:-}" ]; then
    printf 'runtime secret error: %s and %s are mutually exclusive\n' "$name" "$file_name" >&2
    return 1
  fi

  if [ -n "${file:-}" ]; then
    if [ ! -f "$file" ]; then
      printf 'runtime secret error: %s does not reference a regular file\n' "$file_name" >&2
      return 1
    fi
    value=$(cat "$file")
    if [ -z "$value" ]; then
      printf 'runtime secret error: %s is empty\n' "$file_name" >&2
      return 1
    fi
    export "$name=$value"
    unset "$file_name"
  fi
}

for secret_name in \
  DATABASE_URL \
  NVD_API_KEY \
  THREATFOX_AUTH_KEY \
  MALWAREBAZAAR_AUTH_KEY \
  IPINFO_LITE_TOKEN
do
  load_secret "$secret_name"
done

exec "$@"
