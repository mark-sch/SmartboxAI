#!/bin/bash

# Parameter parsen
USER_NAME="${USER}"  # Default
WEB_PORT=""          # Leer = kein Web-Server
KILL_WEB=false       # Prozess auf Port beenden
AGENT_PARAM=""       # Optionaler --agent Parameter
WORK_DIR_PARAM=""    # Optionaler --work-dir Parameter

# Hilfe/Usage anzeigen
show_help() {
    cat << 'EOF'
Usage: launch.sh [OPTIONS] [USERNAME]

Arguments:
  USERNAME          Username for default work directory (default: $USER)

Options:
  --work-dir DIR    Specify custom working directory
  --web-port PORT   Start web server on specified port
  --killweb         Kill process on specified port (requires --web-port)
  --agent AGENT     Specify agent to use
  -h, --help        Show this help message

Examples:
  launch.sh                    # Show this help
  launch.sh myuser             # Use default work dir for user
  launch.sh --work-dir /tmp/project myuser
  launch.sh --web-port 8080 myuser
EOF
}

# Ohne Parameter: Hilfe anzeigen und beenden
if [[ $# -eq 0 ]]; then
    show_help
    exit 0
fi

# Manuelles Parsen der Argumente
while [[ $# -gt 0 ]]; do
    case $1 in
        --web-port)
            WEB_PORT="$2"
            shift 2
            ;;
        --web-port=*)
            WEB_PORT="${1#*=}"
            shift
            ;;
        --killweb)
            KILL_WEB=true
            shift
            ;;
        --agent)
            AGENT_PARAM="$2"
            shift 2
            ;;
        --agent=*)
            AGENT_PARAM="${1#*=}"
            shift
            ;;
        --work-dir)
            WORK_DIR_PARAM="$2"
            shift 2
            ;;
        --work-dir=*)
            WORK_DIR_PARAM="${1#*=}"
            shift
            ;;
        -h|--help)
            show_help
            exit 0
            ;;
        -*)
            echo "Unknown option: $1"
            exit 1
            ;;
        *)
            USER_NAME="$1"
            shift
            ;;
    esac
done

# Fallback auf $USER wenn kein Username angegeben
USER_NAME="${USER_NAME:-$USER}"

# Validierung: --killweb erfordert --web-port
if [[ "$KILL_WEB" == true && -z "$WEB_PORT" ]]; then
    echo "Error: --killweb requires --web-port to be specified"
    exit 1
fi

# Pfade definieren
if [[ -n "$WORK_DIR_PARAM" ]]; then
    WORK_DIR="$WORK_DIR_PARAM"
else
    WORK_DIR="$HOME/SmartboxAI/$USER_NAME"
fi
export KIMI_SHARE_DIR="$HOME/SmartboxAI/.config/$USER_NAME"

# Verzeichnisse erstellen falls nicht vorhanden
mkdir -p "$WORK_DIR" "$KIMI_SHARE_DIR"

# Funktion: Prüfe ob Port verfügbar ist (timeout 1s)
check_port_available() {
    local port=$1
    local timeout_sec=1
    
    # Versuche eine Verbindung zum Port herzustellen
    # Wenn erfolgreich (exit 0), ist der Port belegt
    # Wenn fehlgeschlagen (exit 1), ist der Port frei
    if timeout $timeout_sec bash -c "</dev/tcp/127.0.0.1/$port" 2>/dev/null; then
        return 1  # Port ist belegt
    else
        return 0  # Port ist frei (oder timeout = nicht erreichbar)
    fi
}

# Funktion: Finde und beende Prozess auf Port
kill_process_on_port() {
    local port=$1
    local pid
    
    # Versuche PID über lsof zu finden (bevorzugt)
    if command -v lsof &>/dev/null; then
        pid=$(lsof -ti :"$port" 2>/dev/null)
    fi
    
    # Fallback zu ss wenn lsof nicht verfügbar oder keine PID gefunden
    if [[ -z "$pid" ]] && command -v ss &>/dev/null; then
        pid=$(ss -tlnp "sport = :$port" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1)
    fi
    
    # Fallback zu fuser wenn verfügbar
    if [[ -z "$pid" ]] && command -v fuser &>/dev/null; then
        pid=$(fuser "$port"/tcp 2>/dev/null | tr -d ' ')
    fi
    
    if [[ -n "$pid" ]]; then
        echo "Found process PID $pid listening on port $port"
        kill "$pid" 2>/dev/null
        sleep 1
        # Prüfe ob Prozess noch läuft, dann force kill
        if kill -0 "$pid" 2>/dev/null; then
            kill -9 "$pid" 2>/dev/null
        fi
        echo "Process terminated"
        return 0
    else
        echo "No process found listening on port $port"
        return 1
    fi
}

# Nur Prozess beenden wenn --killweb gesetzt (ohne kimi zu starten)
if [[ "$KILL_WEB" == true && -n "$WEB_PORT" ]]; then
    echo "Checking for process on port $WEB_PORT..."
    
    if ! check_port_available "$WEB_PORT"; then
        kill_process_on_port "$WEB_PORT"
        exit 0
    else
        echo "No process found listening on port $WEB_PORT"
        exit 0
    fi
fi

# Web-Server starten wenn --web-port gesetzt
if [[ -n "$WEB_PORT" ]]; then
    echo "Checking port $WEB_PORT availability..."
    
    if check_port_available "$WEB_PORT"; then
        echo "Port $WEB_PORT is available. Starting Kimi Web Server..."
        
        # Web-Server im Hintergrund starten (unabhängig von CLI)
        # nohup: ignoriert HUP Signal wenn Terminal geschlossen wird
        # STDOUT/STDERR nach /dev/null um Hängen zu vermeiden
        nohup kimi web --port "$WEB_PORT" --no-open >/dev/null 2>&1 &
        WEB_PID=$!
        
        # Kurze Pause für Startup
        sleep 1
        
        # Prüfe ob Prozess läuft
        if kill -0 $WEB_PID 2>/dev/null; then
            echo "✓ Web Server started (PID: $WEB_PID) at http://localhost:$WEB_PORT"
            echo "  Note: Web Server runs independently. Stop with: kill $WEB_PID"
            echo ""
        else
            echo "✗ Web Server failed to start"
        fi
    else
        echo "✗ Port $WEB_PORT is already in use. Web Server not started."
        echo "  Check with: lsof -i :$WEB_PORT  or  netstat -tlnp | grep $WEB_PORT"
        echo ""
    fi
fi

# kimi aufrufen mit --work-dir
if [[ -n "$AGENT_PARAM" ]]; then
    kimi --work-dir "$WORK_DIR" --agent "$AGENT_PARAM"
else
    kimi --work-dir "$WORK_DIR"
fi
