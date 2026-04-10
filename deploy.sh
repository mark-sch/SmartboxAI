#!/bin/bash

if [ -z "$1" ]; then
    echo "Fehler: Parameter erforderlich. Verwendung: $0 <local>"
    exit 1
fi

if [ "$1" = "local" ]; then
    make build-bin
    cp dist/onefile/kimi ~/.local/bin/
else
    echo "Fehler: Unbekannter Parameter '$1'. Unterstützt: local"
    exit 1
fi
