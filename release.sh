#!/usr/bin/env bash
#
# Buduje, podpisuje (przez AMO) i rejestruje nową wersję rozszerzenia do
# self-hostowanej aktualizacji. Po uruchomieniu wystarczy wgrać na serwer
# pliki z katalogu dist/ oraz zaktualizowany updates.json.
#
# Wymagania:
#   - web-ext (uruchamiany przez `npx web-ext`)
#   - jq
#   - klucze API z AMO (https://addons.mozilla.org/developers/addon/api/key/)
#     w pliku .env (patrz .env.example) albo w zmiennych środowiskowych:
#       AMO_JWT_ISSUER, AMO_JWT_SECRET
#
# Użycie:
#   cp .env.example .env   # i uzupełnij klucze
#   ./release.sh
#
set -euo pipefail

cd "$(dirname "$0")"

# Wczytaj klucze API z .env, jeśli istnieje (plik jest ignorowany przez git).
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

BASE_URL="https://addons.necodeo.com"
DIST_DIR="dist"
UPDATES_FILE="updates.json"

# --- Dane z manifestu --------------------------------------------------------
VERSION="$(jq -r '.version' manifest.json)"
ADDON_ID="$(jq -r '.browser_specific_settings.gecko.id' manifest.json)"
XPI_NAME="oa-to-az-${VERSION}.xpi"
UPDATE_LINK="${BASE_URL}/${XPI_NAME}"

echo "==> Wersja:    ${VERSION}"
echo "==> Addon ID:  ${ADDON_ID}"
echo "==> Plik XPI:  ${XPI_NAME}"

# --- Walidacja środowiska ----------------------------------------------------
: "${AMO_JWT_ISSUER:?Ustaw AMO_JWT_ISSUER (klucz API z AMO)}"
: "${AMO_JWT_SECRET:?Ustaw AMO_JWT_SECRET (sekret API z AMO)}"

if jq -e --arg v "$VERSION" \
   '.addons[].updates[]? | select(.version == $v)' "$UPDATES_FILE" >/dev/null; then
  echo "!! Wersja ${VERSION} już istnieje w ${UPDATES_FILE}." >&2
  echo "   Podbij \"version\" w manifest.json przed wydaniem." >&2
  exit 1
fi

# --- Podpisanie przez AMO (kanał unlisted = self-distribution) ---------------
echo "==> Podpisuję paczkę w AMO…"
npx --yes web-ext sign \
  --channel=unlisted \
  --api-key="$AMO_JWT_ISSUER" \
  --api-secret="$AMO_JWT_SECRET" \
  --ignore-files "$DIST_DIR/**" "$UPDATES_FILE" "release.sh" "README.md" "index.html" ".env" ".env.example"

# --- Zebranie podpisanego pliku ----------------------------------------------
SIGNED_XPI="$(ls -t web-ext-artifacts/*.xpi | head -n1)"
if [[ -z "${SIGNED_XPI:-}" || ! -f "$SIGNED_XPI" ]]; then
  echo "!! Nie znaleziono podpisanego .xpi w web-ext-artifacts/." >&2
  exit 1
fi

mkdir -p "$DIST_DIR"
cp "$SIGNED_XPI" "${DIST_DIR}/${XPI_NAME}"
# Stała kopia, na którą wskazuje przycisk instalacji na index.html.
cp "$SIGNED_XPI" "${DIST_DIR}/oa-to-az-latest.xpi"
HASH="sha256:$(sha256sum "${DIST_DIR}/${XPI_NAME}" | cut -d' ' -f1)"
echo "==> Podpisany plik: ${DIST_DIR}/${XPI_NAME}"
echo "==> Hash:           ${HASH}"

# --- Dopisanie wpisu do updates.json -----------------------------------------
echo "==> Aktualizuję ${UPDATES_FILE}…"
tmp="$(mktemp)"
jq --arg id "$ADDON_ID" \
   --arg v "$VERSION" \
   --arg link "$UPDATE_LINK" \
   --arg hash "$HASH" '
  .addons[$id].updates += [
    { "version": $v, "update_link": $link, "update_hash": $hash }
  ]
' "$UPDATES_FILE" > "$tmp"
mv "$tmp" "$UPDATES_FILE"

# --- Podsumowanie ------------------------------------------------------------
cat <<EOF

✓ Gotowe. Wgraj na serwer:
    ${DIST_DIR}/${XPI_NAME}        ->  ${UPDATE_LINK}
    ${DIST_DIR}/oa-to-az-latest.xpi  ->  ${BASE_URL}/oa-to-az-latest.xpi
    ${UPDATES_FILE}               ->  ${BASE_URL}/${UPDATES_FILE}

Pamiętaj wgrać też index.html (raz wystarczy).
Firefox sprawdzi aktualizacje przy najbliższym cyklu (domyślnie co 24 h).
EOF
