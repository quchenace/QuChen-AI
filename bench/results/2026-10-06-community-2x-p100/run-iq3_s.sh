#!/bin/sh
cd "/home/lech/QuChen"
exec "/home/lech/QuChen/.venv/bin/python" "/home/lech/QuChen/serve/server.py" "--engine" "quchen" "--config" "/home/lech/QuChen/quchen-iq3_s.json" "--port" "8080" "--open"
