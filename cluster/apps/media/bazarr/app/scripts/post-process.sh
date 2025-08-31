#!/usr/bin/env bash

printf "Cleaning subtitles for '%s' ...\n" "$1"
python3 /add-ons/subcleaner/subcleaner.py "$1" -s
