#!/bin/bash
cd "$(dirname "$0")"
export DATABASE_URL="postgresql://postgres:dev123@localhost:5432/province_games"
export NODE_ENV="development"
export PORT="3000"
while true; do
    node server.js
    echo "Server crashed. Restarting in 2 seconds..."
    sleep 2
done
