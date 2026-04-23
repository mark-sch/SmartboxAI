#!/bin/bash

if [ -z "$1" ]; then
    echo "Fehler: Parameter erforderlich. Verwendung: $0 <local|office>"
    exit 1
fi

if [ "$1" = "local" ]; then
    make build-bin
    cp dist/onefile/kimi ~/.local/bin/
elif [ "$1" = "office" ]; then
    rsync dist/onefile/kimi sunny5@192.168.0.198:/home/sunny5/.local/bin/kimi
else
    echo "Fehler: Unbekannter Parameter '$1'. Unterstützt: local, office"
    exit 1
fi
